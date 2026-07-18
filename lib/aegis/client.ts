import Anthropic from '@anthropic-ai/sdk';
import {
  AegisError,
  MODEL_IDS,
  isModelDrift,
  type ModelId,
} from './types';
import type { ClaudeUsage } from './context/cost';
import { repairToolPairing } from './context/tool-pairing';
import type { SystemBlock } from './modes';

/**
 * Structured, queryable warning when the **served** model tier differs from the
 * **requested** one — a silent provider swap (e.g. Sonnet requested, Haiku
 * served). Mirrors the `reportUsageLogFailure` style in usage-logger.ts; the
 * stable `event` is the alert hook. Defined here (not in usage-logger) so the
 * client module stays free of the DB import. No-op unless it's a real tier swap.
 */
export function reportModelDrift(requested: string, served: string): void {
  if (!isModelDrift(requested, served)) return;
  console.error(
    JSON.stringify({
      event: 'aegis_model_drift',
      level: 'warn',
      requested,
      served,
    }),
  );
}

// Re-export for callers that need the stream type without depending on the SDK directly.
export type ClaudeMessageStream = ReturnType<Anthropic['messages']['stream']>;

// ───────────────────────── Singleton client ─────────────────────────

let _client: Anthropic | null = null;
const _byokClients = new Map<string, Anthropic>();

// Cap the per-key client cache: unbounded growth would pin every user's raw
// key in memory for the life of a warm serverless instance. 50 distinct BYOK
// keys per instance is far above realistic concurrency; beyond that we evict
// the oldest entry (Map preserves insertion order).
const BYOK_CLIENT_CACHE_MAX = 50;

export function getClient(apiKey?: string | null): Anthropic {
  if (apiKey) {
    const cached = _byokClients.get(apiKey);
    if (cached) return cached;
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    if (_byokClients.size >= BYOK_CLIENT_CACHE_MAX) {
      const oldest = _byokClients.keys().next().value;
      if (oldest !== undefined) _byokClients.delete(oldest);
    }
    _byokClients.set(apiKey, client);
    return client;
  }
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AegisError(
      'internal_error',
      'ANTHROPIC_API_KEY is not set. AEGIS cannot reach the Anthropic API.',
    );
  }
  // `maxRetries: 0` makes our own `shouldRetry` policy authoritative. Without
  // it the SDK ALSO retries (default 2), so a 429/5xx/connection-reset was
  // retried twice by the SDK and once more here — and our retry seed prefix
  // would no longer be the only thing replayed. `shouldRetry` below is a
  // superset of the SDK's default policy, so we lose no coverage.
  _client = new Anthropic({ maxRetries: 0 });
  return _client;
}

// ───────────────────────── Types ─────────────────────────

export type ClaudeCallParams = {
  model: ModelId;
  systemBlocks: SystemBlock[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  /** Optional per-user Anthropic API key (BYOK). Never logged or returned. */
  apiKey?: string | null;
  /**
   * Optional tool-choice override. 3.1 sets `{ type: 'none' }` to force a final,
   * tool-free answer — the `tools` array is kept intact so the cached tool-list
   * prefix still matches; only this top-level param changes.
   */
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
};

// ───────────────────────── Cache control wiring ─────────────────────────

/**
 * Convert our `SystemBlock[]` into Anthropic's `TextBlockParam[]`.
 * Cache breakpoint goes on the **last** block flagged `cached: true`.
 * Everything up to and including that block is served from the cache when
 * the prefix matches an earlier request.
 */
function buildSystemBlocks(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  let lastCachedIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].cached) lastCachedIdx = i;
  }
  return blocks.map((b, i) => {
    const param: Anthropic.TextBlockParam = { type: 'text', text: b.text };
    if (i === lastCachedIdx) {
      param.cache_control = { type: 'ephemeral' };
    }
    return param;
  });
}

/**
 * Mark the **last** tool with `cache_control: ephemeral` so the entire tool
 * list is cached as part of the prefix. Returns a new array — does not mutate
 * the input (tool schemas are module-level singletons).
 */
function withToolCacheBreakpoint(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [
    ...tools.slice(0, -1),
    { ...last, cache_control: { type: 'ephemeral' } },
  ];
}

/**
 * Rolling conversation cache breakpoint.
 *
 * Places a 5-minute `ephemeral` breakpoint on the **last content block of the
 * last message**, so everything sent so far (system + tools + the whole
 * conversation up to this point) becomes a cacheable prefix. Because the inner
 * loop is append-only, the previous call already cached the prefix `[0..N-1]`;
 * this call reads that from cache (~10% of input price) and only cache-*writes*
 * the new turn. Each iteration the breakpoint rolls forward to the new tail.
 *
 * Placement details:
 *   - The last message before any Claude call is always a `user` message
 *     (initial input, tool_results, a compressed-history summary, or verify
 *     feedback), whose content is a string or a `tool_result` block array.
 *   - A `string` content must be promoted to a `text` block to carry
 *     `cache_control`; an array gets the breakpoint on its last block.
 *
 * Non-destructive: clones the array and the touched message — never mutates the
 * loop's `state.messages` (which is reused across iterations).
 *
 * This is the 3rd breakpoint (system + tools are the other two); the Anthropic
 * cap is 4, so we stay within budget. Compaction (which rewrites the message
 * list) is handled automatically: placement is recomputed every call, so the
 * breakpoint simply re-anchors on the post-compaction tail.
 */
function withMessageCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  const cacheControl = { type: 'ephemeral' as const };

  let content: Anthropic.ContentBlockParam[];
  if (typeof last.content === 'string') {
    content = [{ type: 'text', text: last.content, cache_control: cacheControl }];
  } else {
    if (last.content.length === 0) return messages; // nothing to mark
    content = last.content.slice();
    const i = content.length - 1;
    // `cache_control` is accepted on the block param types we ever put last
    // (text / tool_result); the cast satisfies the wide ContentBlockParam union.
    content[i] = { ...content[i], cache_control: cacheControl } as Anthropic.ContentBlockParam;
  }

  const cloned = messages.slice();
  cloned[lastIdx] = { ...last, content };
  return cloned;
}

// Exported for unit tests (placement + non-mutation).
export { withMessageCacheBreakpoint };

// ───────────────────────── Retry policy ─────────────────────────

// Superset of the SDK's own default retry policy (which we disable via
// `maxRetries: 0`). The SDK retried connection errors, 408, 409, 429, and
// EVERY status ≥ 500 — that open-ended ≥500 range matters: it includes 529,
// Anthropic's dedicated `overloaded_error` status, the failure most likely
// under live provider load (ARCH-01; a fixed status set silently dropped it).
const RETRYABLE_STATUS = new Set([408, 409, 429]);

// Exported for unit tests (the predicate matrix, without real retry sleeps).
export function shouldRetry(err: unknown): boolean {
  // Connection resets / timeouts — the case the SDK covered and a naive
  // status-only policy would have dropped.
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!err || typeof err !== 'object') return false;
  // Anthropic SDK exposes `status` on APIError instances.
  const status = (err as { status?: number }).status;
  if (typeof status !== 'number') return false;
  return status >= 500 || RETRYABLE_STATUS.has(status);
}

/**
 * Exponential backoff with full jitter (exported for tests): attempt 1 → up
 * to 1 s, attempt 2 → up to 2 s, capped at `capMs`. A Retry-After header
 * (seconds), when the provider sends one on 429/529, takes precedence —
 * still capped, so a hostile/huge header can't stall the request budget.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterSeconds?: number,
  capMs = 8000,
  random: () => number = Math.random,
): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, capMs);
  }
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), capMs);
  return Math.round(random() * ceiling);
}

/** Retry-After seconds from an SDK APIError's response headers, if present. */
export function readRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const headers = (err as { headers?: unknown }).headers;
  let raw: string | null | undefined;
  if (headers instanceof Headers) raw = headers.get('retry-after');
  else if (headers && typeof headers === 'object') {
    const rec = headers as Record<string, string>;
    raw = rec['retry-after'] ?? rec['Retry-After'];
  }
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for unit tests (BYOK vs system auth-error mapping).
export function classifyUpstream(err: unknown, usedByokKey = false): AegisError {
  // Full detail (prompt/schema validation messages, SDK internals) goes to the
  // server log only — AegisError messages reach the client and must not leak
  // system-prompt or tool-schema structure.
  console.error(
    JSON.stringify({
      event: 'aegis_upstream_error',
      level: 'error',
      name: err instanceof Error ? err.name : typeof err,
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
  if (err instanceof Anthropic.AuthenticationError) {
    // BYOK: the USER's stored key was rejected — actionable for them, not an
    // internal defect. Without BYOK it's our system key → internal.
    if (usedByokKey) {
      return new AegisError(
        'invalid_input',
        'Ihr hinterlegter Anthropic API-Schlüssel wurde von Anthropic abgelehnt. Bitte prüfen Sie ihn unter Konto → AI-Provider oder löschen Sie ihn, um den System-Provider zu verwenden.',
      );
    }
    return new AegisError('internal_error', 'Anthropic auth failed — check ANTHROPIC_API_KEY.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    // Our prompt or schema is malformed; that's an internal bug, not upstream.
    return new AegisError('internal_error', 'Anthropic rejected the request. Check server logs.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AegisError('upstream_error', 'Anthropic rate-limited the request.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AegisError('upstream_error', 'Anthropic API connection failed.');
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new AegisError('upstream_error', 'Anthropic API returned 5xx.');
  }
  return new AegisError('upstream_error', 'Unexpected upstream error. Check server logs.');
}

// ───────────────────────── Public entry ─────────────────────────

/**
 * Singleton-backed wrapper around `messages.create`. Handles:
 *   - prompt cache breakpoints on system blocks + tool list,
 *   - up to 2 retries on 408/409/429/≥500 (incl. 529 overloaded) with
 *     jittered exponential backoff honoring Retry-After,
 *   - structured logging on every successful call,
 *   - normalised `AegisError` on any failure.
 *
 * Any module that needs to talk to Claude inside `lib/aegis/` must go through
 * this function.
 */
export async function callClaude(
  params: ClaudeCallParams,
): Promise<Anthropic.Message> {
  const client = getClient(params.apiKey);
  const startedAt = Date.now();

  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: params.model,
    system: buildSystemBlocks(params.systemBlocks),
    tools: withToolCacheBreakpoint(params.tools),
    messages: withMessageCacheBreakpoint(repairToolPairing(params.messages)),
    max_tokens: params.maxTokens,
    ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
  };

  // 3 total attempts (= the SDK's old 2 retries). `request` is built ONCE above
  // and replayed verbatim, so attempts 2–3 share a byte-identical cache prefix.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create(request);
      const durationMs = Date.now() - startedAt;
      const usage = response.usage;
      console.info(
        JSON.stringify({
          event: 'claude_call',
          model: params.model,
          servedModel: response.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          stopReason: response.stop_reason,
          durationMs,
          attempt,
        }),
      );
      // Covers every non-streaming call — the main loop AND the Haiku helpers
      // (classifyIntent / compressContext) all route through here.
      reportModelDrift(params.model, response.model);
      return response;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && shouldRetry(err)) {
        await sleep(retryDelayMs(attempt, readRetryAfterSeconds(err)));
        continue;
      }
      throw classifyUpstream(err, !!params.apiKey);
    }
  }

  // Unreachable — the for-loop either returns or throws.
  throw new AegisError('upstream_error', 'callClaude exhausted retry loop.');
}

// ───────────────────────── Streaming entry ─────────────────────────

/**
 * Streaming variant of `callClaude`. Returns the Anthropic `MessageStream`
 * directly — the caller iterates events and may call `.finalMessage()` to
 * get the assembled message + usage once the stream completes. Used by the
 * SSE path; tool-only iterations may also use this (so the agent can emit
 * incremental events to the client during text-then-tool_use phases).
 *
 * Retry policy: one-shot retry around stream CREATION only, before the first
 * byte. `stream.emitted('connect')` resolves once the connection is established
 * and rejects if it fails to connect — so a connection reset/timeout during
 * setup is retried once (the SDK no longer does this under `maxRetries: 0`).
 * Once bytes are flowing a mid-stream failure is NOT retried (non-idempotent —
 * the client already received partial output); the outer loop surfaces it.
 *
 * `request` is built ONCE and replayed verbatim on the retry, so the cache
 * prefix stays byte-identical. Async because we await the connect handshake.
 */
export async function streamClaude(
  params: ClaudeCallParams,
): Promise<ClaudeMessageStream> {
  const client = getClient(params.apiKey);
  const request: Anthropic.MessageCreateParamsStreaming = {
    model: params.model,
    system: buildSystemBlocks(params.systemBlocks),
    tools: withToolCacheBreakpoint(params.tools),
    messages: withMessageCacheBreakpoint(repairToolPairing(params.messages)),
    max_tokens: params.maxTokens,
    stream: true,
    ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
  };

  const open = (): ClaudeMessageStream => client.messages.stream(request);

  let stream = open();
  try {
    await stream.emitted('connect');
    return stream;
  } catch (err) {
    if (!shouldRetry(err)) throw classifyUpstream(err, !!params.apiKey);
    // One-shot reconnect, before any byte was forwarded to the client.
    stream = open();
    try {
      await stream.emitted('connect');
      return stream;
    } catch (err2) {
      throw classifyUpstream(err2, !!params.apiKey);
    }
  }
}

// ───────────────────────── Lightweight Haiku adapter ─────────────────────────

/**
 * Single-shot Haiku call for compression + intent classification.
 * Matches `CompressCallFn` / `CallModelFn` (router.ts) signatures so callers
 * can inject this directly without an adapter.
 *
 * No tools, no system block other than the prompt — used for pure text-in /
 * text-out helpers. Errors propagate as `AegisError('upstream_error')`.
 */
export async function callHaiku(params: {
  model: ModelId;
  prompt: string;
  maxTokens: number;
}): Promise<{ text: string; usage: ClaudeUsage }> {
  const response = await callClaude({
    model: params.model ?? MODEL_IDS.haiku,
    systemBlocks: [],
    tools: [],
    messages: [{ role: 'user', content: params.prompt }],
    maxTokens: params.maxTokens,
  });
  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  // Surface usage so callers can fold this helper call's cost into the run's
  // accumulator — otherwise intent/compression Haiku spend goes unlogged.
  return { text, usage: response.usage };
}

// ───────────────────────── Structured single-shot ─────────────────────────

/**
 * Single-shot structured-output call (no tools, no streaming). Constrains the
 * response to `schema` via `output_config.format` and returns the parsed JSON.
 * Used by the context-compaction digest. One attempt + the shared upstream
 * error classifier — this is a user-triggered, non-hot-path call.
 */
export async function callStructured<T>(params: {
  model: ModelId;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<{ value: T; usage: ClaudeUsage }> {
  const client = getClient();
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: 'user', content: params.prompt }],
      // Constrain output to the schema (structured outputs). Canonical param.
      output_config: { format: { type: 'json_schema', schema: params.schema } },
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (err) {
    throw classifyUpstream(err);
  }

  // Output-side guards — handled OUTSIDE the upstream try so a truncated or
  // malformed result surfaces as a clear, distinct failure rather than being
  // misclassified as a transport error (or throwing an opaque SyntaxError).
  if (response.stop_reason === 'max_tokens') {
    throw new AegisError(
      'upstream_error',
      'Structured output was truncated (hit max_tokens) — result is incomplete.',
    );
  }
  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('');
  try {
    return { value: JSON.parse(text) as T, usage: response.usage };
  } catch {
    throw new AegisError('upstream_error', 'Structured output was not valid JSON.');
  }
}
