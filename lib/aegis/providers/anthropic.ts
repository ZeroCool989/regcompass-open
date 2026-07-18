import Anthropic from '@anthropic-ai/sdk';
import { AegisError, MODEL_IDS, isModelDrift, type ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';
import { repairToolPairing } from '../context/tool-pairing';
import type { SystemBlock } from '../modes';
import type {
  ModelProvider,
  ProviderCallParams,
  ProviderCapabilities,
  ProviderMessage,
  ProviderMessageStream,
} from './types';

/**
 * Reference backend: Anthropic. The only module that imports the Anthropic SDK
 * for dispatch. All dispatch/retry/cache/error logic lives here; `client.ts` is
 * a thin facade that delegates to the registry-selected provider.
 */

// ───────────────────────── Model-drift warning ─────────────────────────

export function reportModelDrift(requested: string, served: string): void {
  if (!isModelDrift(requested, served)) return;
  console.error(
    JSON.stringify({ event: 'aegis_model_drift', level: 'warn', requested, served }),
  );
}

// ───────────────────────── SDK client cache ─────────────────────────

let _client: Anthropic | null = null;
const _byokClients = new Map<string, Anthropic>();
const BYOK_CLIENT_CACHE_MAX = 50;

export function getClient(apiKey?: string | null, authToken?: string | null): Anthropic {
  // A connected Claude subscription supplies an OAuth access token, sent as a
  // Bearer credential (Authorization) rather than the x-api-key header.
  if (authToken) {
    const cacheKey = `oauth:${authToken}`;
    const cached = _byokClients.get(cacheKey);
    if (cached) return cached;
    const client = new Anthropic({ authToken, maxRetries: 0 });
    if (_byokClients.size >= BYOK_CLIENT_CACHE_MAX) {
      const oldest = _byokClients.keys().next().value;
      if (oldest !== undefined) _byokClients.delete(oldest);
    }
    _byokClients.set(cacheKey, client);
    return client;
  }
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
  _client = new Anthropic({ maxRetries: 0 });
  return _client;
}

// ───────────────────────── Cache-control wiring ─────────────────────────

function buildSystemBlocks(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  let lastCachedIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].cached) lastCachedIdx = i;
  }
  return blocks.map((b, i) => {
    const param: Anthropic.TextBlockParam = { type: 'text', text: b.text };
    if (i === lastCachedIdx) param.cache_control = { type: 'ephemeral' };
    return param;
  });
}

function withToolCacheBreakpoint(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }];
}

export function withMessageCacheBreakpoint(
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
    if (last.content.length === 0) return messages;
    content = last.content.slice();
    const i = content.length - 1;
    content[i] = { ...content[i], cache_control: cacheControl } as Anthropic.ContentBlockParam;
  }
  const cloned = messages.slice();
  cloned[lastIdx] = { ...last, content };
  return cloned;
}

// ───────────────────────── Retry policy ─────────────────────────

const RETRYABLE_STATUS = new Set([408, 409, 429]);

export function shouldRetry(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  if (typeof status !== 'number') return false;
  return status >= 500 || RETRYABLE_STATUS.has(status);
}

export function retryDelayMs(
  attempt: number,
  retryAfterSeconds?: number,
  capMs = 8000,
  random: () => number = Math.random,
): number {
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(retryAfterSeconds * 1000, capMs);
  }
  const ceiling = Math.min(1000 * 2 ** (attempt - 1), capMs);
  return Math.round(random() * ceiling);
}

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

export function classifyUpstream(err: unknown, usedByokKey = false): AegisError {
  console.error(
    JSON.stringify({
      event: 'aegis_upstream_error',
      level: 'error',
      name: err instanceof Error ? err.name : typeof err,
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
  if (err instanceof Anthropic.AuthenticationError) {
    if (usedByokKey) {
      return new AegisError(
        'invalid_input',
        'Ihr hinterlegter Anthropic API-Schlüssel wurde von Anthropic abgelehnt. Bitte prüfen Sie ihn unter Konto → AI-Provider oder löschen Sie ihn, um den System-Provider zu verwenden.',
      );
    }
    return new AegisError('internal_error', 'Anthropic auth failed — check ANTHROPIC_API_KEY.');
  }
  if (err instanceof Anthropic.BadRequestError) {
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

// ───────────────────────── Provider ─────────────────────────

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    promptCache: true,
    toolChoice: true,
    structuredOutput: true,
  };

  async createMessage(params: ProviderCallParams): Promise<ProviderMessage> {
    const client = getClient(params.apiKey, params.authToken);
    const startedAt = Date.now();
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      system: buildSystemBlocks(params.systemBlocks),
      tools: withToolCacheBreakpoint(params.tools),
      messages: withMessageCacheBreakpoint(repairToolPairing(params.messages)),
      max_tokens: params.maxTokens,
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    };

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
    throw new AegisError('upstream_error', 'callClaude exhausted retry loop.');
  }

  async streamMessage(params: ProviderCallParams): Promise<ProviderMessageStream> {
    const client = getClient(params.apiKey, params.authToken);
    const request: Anthropic.MessageCreateParamsStreaming = {
      model: params.model,
      system: buildSystemBlocks(params.systemBlocks),
      tools: withToolCacheBreakpoint(params.tools),
      messages: withMessageCacheBreakpoint(repairToolPairing(params.messages)),
      max_tokens: params.maxTokens,
      stream: true,
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    };
    // Concrete SDK stream so `.emitted('connect')` is available here; the return
    // type widens to the neutral ProviderMessageStream for callers.
    const open = () => client.messages.stream(request);

    let stream = open();
    try {
      await stream.emitted('connect');
      return stream;
    } catch (err) {
      if (!shouldRetry(err)) throw classifyUpstream(err, !!params.apiKey);
      stream = open();
      try {
        await stream.emitted('connect');
        return stream;
      } catch (err2) {
        throw classifyUpstream(err2, !!params.apiKey);
      }
    }
  }

  async completeText(params: {
    model: ModelId;
    prompt: string;
    maxTokens: number;
    apiKey?: string | null;
    authToken?: string | null;
  }): Promise<{ text: string; usage: ClaudeUsage }> {
    const response = await this.createMessage({
      model: params.model ?? MODEL_IDS.haiku,
      systemBlocks: [],
      tools: [],
      messages: [{ role: 'user', content: params.prompt }],
      maxTokens: params.maxTokens,
      apiKey: params.apiKey,
      authToken: params.authToken,
    });
    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { text, usage: response.usage };
  }

  async structured<T>(params: {
    model: ModelId;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    apiKey?: string | null;
    authToken?: string | null;
  }): Promise<{ value: T; usage: ClaudeUsage }> {
    const client = getClient(params.apiKey, params.authToken);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: [{ role: 'user', content: params.prompt }],
        output_config: { format: { type: 'json_schema', schema: params.schema } },
      } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (err) {
      throw classifyUpstream(err);
    }
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
}
