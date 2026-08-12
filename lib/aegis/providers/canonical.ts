import { AegisError } from '../types';
import type { ClaudeUsage } from '../context/cost';
import type {
  ProviderContentBlock,
  ProviderMessage,
  ProviderStopReason,
  ProviderStreamEvent,
} from './types';

/**
 * Shared helpers for non-reference backends (OpenAI-compatible, Gemini, …).
 *
 * The canonical in-process message/event shape is structural (see types.ts). A
 * backend translates its own wire format into these shapes; the builders below
 * construct structurally-valid canonical objects. Casts are localized here and
 * cover only fields no consumer reads (SDK-internal usage/message metadata).
 */

export function canonicalUsage(inputTokens: number, outputTokens: number): ClaudeUsage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  };
}

/** Assemble a canonical (assistant) message from translated content + usage. */
export function buildCanonicalMessage(args: {
  model: string;
  content: ProviderContentBlock[];
  stopReason: ProviderStopReason;
  usage: ClaudeUsage;
}): ProviderMessage {
  return {
    id: `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: args.model,
    content: args.content,
    stop_reason: args.stopReason,
    stop_sequence: null,
    usage: args.usage,
  } as unknown as ProviderMessage;
}

export function textBlock(text: string): ProviderContentBlock {
  return { type: 'text', text, citations: null } as unknown as ProviderContentBlock;
}

export function toolUseBlock(id: string, name: string, input: unknown): ProviderContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as ProviderContentBlock;
}

// ─────────────────── Canonical stream events ───────────────────

export function textDeltaEvent(text: string): ProviderStreamEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  } as unknown as ProviderStreamEvent;
}

export function toolUseStartEvent(index: number, id: string, name: string): ProviderStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  } as unknown as ProviderStreamEvent;
}

// ─────────────────── stop-reason mapping ───────────────────

/**
 * Map an OpenAI-/Gemini-style finish_reason onto the canonical stop_reason.
 * Every Gemini "the model declined / was filtered" finish is mapped explicitly to
 * `refusal` — never silently to `end_turn` (which would present a blocked answer
 * as a clean completion). The loop then handles `refusal` as its typed outcome.
 */
export function mapFinishReason(reason: string | null | undefined): ProviderStopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'content_filter':
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

// ─────────────────── HTTP retry (fetch-based backends) ───────────────────

const RETRYABLE_STATUS = new Set([408, 409, 429]);

function retryable(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUS.has(status);
}

function backoffMs(attempt: number, retryAfterSeconds?: number, cap = 8000): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, cap);
  }
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), cap);
  return Math.round(Math.random() * ceiling);
}

function retryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST JSON with the same retry posture as the reference backend: exponential
 * backoff + jitter on 408/409/429/5xx and network errors, honoring Retry-After.
 * On a non-retryable error status, throws a classified AegisError.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: {
    maxAttempts?: number;
    usedByokKey?: boolean;
    providerLabel: string;
    /** Abort signal — cancels the request on client disconnect. An abort is NOT
     *  a retryable failure: it throws immediately without another attempt. */
    signal?: AbortSignal;
  } = { providerLabel: 'model provider' },
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      // A cancellation is a deliberate stop, never a transient error — do not
      // retry, and surface it as a clean cancelled state (no key/payload leak).
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new AegisError('upstream_error', `${opts.providerLabel} request was cancelled.`);
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      logUpstream(err);
      throw new AegisError('upstream_error', `${opts.providerLabel} connection failed.`);
    }
    if (res.ok) return res;
    if (attempt < maxAttempts && retryable(res.status)) {
      await sleep(backoffMs(attempt, retryAfter(res)));
      continue;
    }
    throw await classifyHttp(res, opts.providerLabel, !!opts.usedByokKey);
  }
  throw new AegisError('upstream_error', `${opts.providerLabel} exhausted retry loop.`);
}

function logUpstream(err: unknown): void {
  console.error(
    JSON.stringify({
      event: 'aegis_upstream_error',
      level: 'error',
      name: err instanceof Error ? err.name : typeof err,
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
}

async function classifyHttp(res: Response, label: string, usedByokKey: boolean): Promise<AegisError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    /* ignore */
  }
  console.error(
    JSON.stringify({ event: 'aegis_upstream_error', level: 'error', status: res.status, label }),
  );
  if (res.status === 401 || res.status === 403) {
    if (usedByokKey) {
      return new AegisError(
        'invalid_input',
        'Ihr hinterlegter API-Schlüssel wurde vom Anbieter abgelehnt. Bitte prüfen Sie ihn unter Konto → AI-Provider oder löschen Sie ihn, um den System-Provider zu verwenden.',
      );
    }
    return new AegisError('internal_error', `${label} authentication failed — check the API key.`);
  }
  if (res.status === 400) {
    return new AegisError('internal_error', `${label} rejected the request. Check server logs.`);
  }
  if (res.status === 429) {
    return new AegisError('upstream_error', `${label} rate-limited the request.`);
  }
  return new AegisError('upstream_error', `${label} returned ${res.status}. ${detail}`.trim());
}

// ─────────────────── SSE parsing ───────────────────

/**
 * Parse a `text/event-stream` body into successive JSON `data:` payloads.
 * Yields each parsed object; skips the `[DONE]` sentinel and non-data lines.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]' || data === '') continue;
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore malformed keep-alive fragments */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
