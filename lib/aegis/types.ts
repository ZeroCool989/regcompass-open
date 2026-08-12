import { z } from 'zod';
import { MemoryConfig } from './memory-config';
import { intEnv } from './env';
import { AEGIS_MESSAGE_MAX_CHARS_DEFAULT } from './limits';

// ───────────────────────── Mode ─────────────────────────

export const AegisMode = z.enum([
  'ASSESS',
  'GAP_ANALYZE',
  'CONVERSATIONAL',
]);
export type AegisMode = z.infer<typeof AegisMode>;

/**
 * Mode as accepted at input boundaries. The retired CONTROL_ADVISE mode was
 * folded into CONVERSATIONAL (its control-recommendation workflow now lives in
 * the conversational prompt); conversations and clients that still carry the
 * old value coerce instead of erroring.
 */
export const AegisModeInput = z.preprocess(
  (v) => (v === 'CONTROL_ADVISE' ? 'CONVERSATIONAL' : v),
  AegisMode,
);

// ───────────────────────── Models & Pricing ─────────────────────────

export const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
} as const;
export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

// Bump whenever any rate in `MODEL_COSTS` changes. Persisted alongside each
// usage row so a historical cost can be recomputed from the stored raw token
// buckets after a rate revision.
export const PRICING_VERSION = '2026-06-02';

/**
 * Per-model rates in **USD per million tokens**, one entry per billable bucket
 * the Anthropic API reports separately:
 *   - `input`        — fresh, uncached input (`usage.input_tokens`).
 *   - `output`       — generated output (`usage.output_tokens`).
 *   - `cacheRead`    — prompt-cache hits (`usage.cache_read_input_tokens`), ~10 % of input.
 *   - `cacheWrite5m` — 5-minute cache writes (default TTL).
 *   - `cacheWrite1h` — 1-hour cache writes.
 *
 * Cache writes are billed at a premium over fresh input (5m = 1.25×, 1h = 2×),
 * so they MUST NOT be priced at the plain input rate.
 * Source: Anthropic pricing, verified 2026-06-02.
 */
export type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

export const MODEL_COSTS: Record<ModelId, ModelPricing> = {
  [MODEL_IDS.haiku]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  [MODEL_IDS.sonnet]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  [MODEL_IDS.opus]: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};

// ───────────────────── Provider-qualified model reference & pricing ─────────────────────

/**
 * The runtime brains AEGIS can be pointed at. Cost is attributed *per provider +
 * model*, never by model name alone — the same nominal string could belong to a
 * different provider with different (or no) per-token pricing.
 *
 * The first three are the product's selectable providers (the three-card model).
 * The remainder are the local `AEGIS_BRAIN` escape-hatch brains a downloadable
 * install can point AEGIS at (see `.env.example` / `providers/catalog.ts`); each
 * is attributed to its own label so its spend is never fake-priced as Anthropic:
 *   - `openai`  — real OpenAI or an OpenAI-proper endpoint (per-token, no rate
 *                 configured here → `pricing_unknown`).
 *   - `ollama`  — a local model (no marginal cost we track → `pricing_unknown`).
 *   - `custom`  — a self-hosted / gateway OpenAI-compatible endpoint
 *                 (`pricing_unknown`).
 *   - `cli`     — a local agent CLI you are already signed in to; billed by that
 *                 subscription, not per API token → `subscription_unpriced`.
 */
export type ModelProviderId =
  | 'anthropic'
  | 'gemini'
  | 'chatgpt-codex'
  | 'openai'
  | 'ollama'
  | 'custom'
  | 'cli';

/** A provider-qualified model reference — the key for pricing and usage rows. */
export type ModelRef = { provider: ModelProviderId; model: string };

/**
 * Cost-attribution status for a call/run:
 *  - `priced`               — a per-token rate is configured for (provider, model).
 *  - `subscription_unpriced`— billed by a consumer subscription (e.g. ChatGPT via
 *                             Codex); no per-token API price applies → cost is null.
 *  - `pricing_unknown`      — a per-token provider whose (provider, model) rate is
 *                             not configured; cost is null. We NEVER substitute
 *                             another provider's rates to fill the gap.
 */
export type PriceStatus = 'priced' | 'subscription_unpriced' | 'pricing_unknown';

/**
 * Providers billed per API token (an unconfigured rate → `pricing_unknown`).
 * The subscription-billed brains — `chatgpt-codex` and the local `cli` bridge —
 * are absent, so an unpriced call on them resolves to `subscription_unpriced`.
 * `ollama`/`custom` are local/self-hosted: we hold no rate, so they read as
 * `pricing_unknown` (cost null) rather than a fabricated figure.
 */
const PER_TOKEN_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
  'anthropic',
  'gemini',
  'openai',
  'ollama',
  'custom',
]);

/**
 * Provider-qualified pricing (USD per 1M tokens). ONLY (provider, model) pairs
 * present here are priced; anything else resolves to `pricing_unknown` (cost
 * null) — we never borrow another provider's rate.
 *
 * - `anthropic`: the verified rates from {@link MODEL_COSTS}.
 * - `gemini`: intentionally EMPTY until each model's rate is verified against
 *   real Google billing. An unverified rate would misreport spend, so a Gemini
 *   call stays `pricing_unknown` (cost null) until a rate is added here. Add a
 *   `'model-id': { input, output, cacheRead, cacheWrite5m, cacheWrite1h }` entry
 *   once confirmed; `computeCostRef` prices it immediately (proven in tests).
 * - `chatgpt-codex`: never per-token priced here — subscription-billed.
 */
export const PRICING: Record<ModelProviderId, Record<string, ModelPricing>> = {
  anthropic: { ...MODEL_COSTS },
  gemini: {},
  'chatgpt-codex': {},
  // Local `AEGIS_BRAIN` escape-hatch brains: no verified rate → never priced.
  // (openai/ollama/custom → pricing_unknown; cli → subscription_unpriced via the
  // PER_TOKEN_PROVIDERS membership above. Add a verified rate here to price one.)
  openai: {},
  ollama: {},
  custom: {},
  cli: {},
};

export function lookupPricing(ref: ModelRef): ModelPricing | null {
  return PRICING[ref.provider]?.[ref.model] ?? null;
}

/** Status for a ref with no configured rate: subscription vs unknown-per-token. */
export function priceStatusFor(ref: ModelRef): PriceStatus {
  if (lookupPricing(ref)) return 'priced';
  return PER_TOKEN_PROVIDERS.has(ref.provider) ? 'pricing_unknown' : 'subscription_unpriced';
}

// ───────────────────────── Model drift ─────────────────────────

/** Coarse model tier, independent of any version/snapshot suffix. */
export type ModelFamily = 'haiku' | 'sonnet' | 'opus';

/**
 * Extract the tier/family from a model id, tolerating a dated snapshot suffix
 * (e.g. `claude-sonnet-4-6-20260207` → `sonnet`). Returns `null` if no known
 * tier token is present.
 *
 * (Empirically the API echoes the requested id verbatim today, so exact compare
 * would also work — but a family compare is future-proof against dated variants.)
 */
export function modelFamily(model: string): ModelFamily | null {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return null;
}

/**
 * Drift = a **tier swap** between the requested and the served model
 * (e.g. sonnet → haiku). A version/snapshot suffix on the same tier is NOT
 * drift. If either family can't be parsed, we don't assert drift (no false
 * positives on an unrecognised id).
 */
export function isModelDrift(requested: string, served: string): boolean {
  const r = modelFamily(requested);
  const s = modelFamily(served);
  if (r === null || s === null) return false;
  return r !== s;
}

// ───────────────────────── Request & Response ─────────────────────────

export const AegisHistoryMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citedIds: z.array(z.string()).optional(),
});
export type AegisHistoryMessage = z.infer<typeof AegisHistoryMessage>;

export const AegisRequest = z.object({
  mode: AegisModeInput,
  // Sized for multi-section report prompts (sectioned generation). The client
  // textarea enforces the same default via `maxLength` (see limits.ts) so users
  // never hit this server bound with a visible error.
  message: z.string().min(5).max(intEnv('AEGIS_MESSAGE_MAX_CHARS', AEGIS_MESSAGE_MAX_CHARS_DEFAULT)),
  conversationId: z.string().uuid().optional(),
  language: z.enum(['de', 'en']).default('de'),
  history: z.array(AegisHistoryMessage).max(40).default([]),
  /**
   * Voice channel marker. When `true`, the runtime lowers `maxIterations`
   * to 5 and `maxTokens` to 1024 — shorter, snappier answers suitable for
   * TTS playback.
   */
  voice: z.boolean().default(false),
});
export type AegisRequest = z.infer<typeof AegisRequest>;

export type ToolName =
  | 'search_kb'
  | 'get_requirements'
  | 'get_crosswalk'
  | 'generate_report'
  | 'analyze_document'
  | 'fill_template'
  | 'read_source'
  | 'search_ingested_documents'
  | 'generate_assessment_deck'
  | 'export_assessment'
  | 'improve_uploaded_deck'
  | 'improve_document';

export type ToolCall = {
  id: string;
  name: ToolName;
  input: unknown;
};

export type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

/**
 * Per-request context handed to tool executors. `sessionId` scopes document
 * lookups to the requesting browser session (see lib/session.ts); tools that
 * don't touch documents ignore it. `userId`/`conversationId` let terminal
 * deliverable tools (fill_template) use the CURRENT conversation as a finding
 * source with the same ownership rules as the memory layer — the model never
 * has to know or pass the conversation id itself.
 */
export type ToolContext = {
  sessionId: string | null;
  userId?: string | null;
  conversationId?: string | null;
  /**
   * Cost hook: tools that spend model tokens (conversation-findings extraction)
   * report every call here so the spend lands in the run's CostAccumulator —
   * cost cap and usage dashboard see tool-level model calls, not only loop
   * calls. Optional: absent in tests/legacy callers → spend is not folded in
   * (pre-existing behaviour).
   */
  onUsage?: (model: ModelId, usage: import('./context/cost').ClaudeUsage) => void;
  /** Optional per-request Anthropic BYOK credential. Server-only, never exposed to tools/model text. */
  anthropicApiKey?: string | null;
  /**
   * Explicit request-scoped runtime provider (the user's selection). Threaded
   * onto every model call in the loop so dispatch honours the selection and no
   * `AEGIS_BRAIN` env override can silently replace it. Absent → legacy
   * env/model-family resolution (internal/escape-hatch calls).
   */
  provider?: 'anthropic' | 'gemini';
};

/**
 * One tool invocation captured in full for the conversation audit sidecar
 * (`AegisMessage.toolCalls`). Unlike `AegisResponse['toolCalls']` (which
 * truncates results to a 200-char preview for the client), this keeps the
 * complete result text. Never replayed into a prompt.
 */
export type ToolAuditEntry = {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
};

// ───────────────────────── Verify ─────────────────────────

export type VerifyCheck =
  | 'citation_coverage'
  | 'no_hallucinated_regulations'
  | 'unsupported_regulatory_claim'
  | 'language_consistency'
  | 'non_empty_response'
  | 'no_false_ignorance';

/** A soft check that failed but was downgraded to a non-blocking warning (3.2). */
export type VerifyWarning = { check: VerifyCheck; reason: string };

export type VerifyResult =
  // Clean pass, or "verified with warnings" when `warnings` is non-empty: hard
  // checks passed and only soft checks tripped (3.2). A warned check is marked
  // 'warn' in `checks`.
  | { ok: true; checks: Record<VerifyCheck, 'pass' | 'warn'>; warnings?: VerifyWarning[] }
  | { ok: false; failed: VerifyCheck; reason: string; feedback: string };

// ───────────────────────── Cost ─────────────────────────

export type CostBreakdown = {
  /** Fresh, uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache READ tokens (`cache_read_input_tokens`). */
  cachedTokens: number;
  /** Prompt-cache WRITE tokens (`cache_creation_input_tokens`, both TTLs). */
  cacheCreationTokens: number;
  usd: number;
};

// ───────────────────────── Telemetry ─────────────────────────

export type TraceEvent =
  | {
      type: 'call_start';
      iteration: number;
      model: ModelId;
      timestamp: number;
    }
  | {
      type: 'call_end';
      iteration: number;
      model: ModelId;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: 'tool_call';
      iteration: number;
      name: ToolName;
      input: unknown;
      timestamp: number;
    }
  | {
      type: 'tool_result';
      iteration: number;
      name: ToolName;
      resultPreview: string;
      isError: boolean;
      timestamp: number;
    }
  | {
      type: 'guardrail';
      phase: 'pre' | 'post';
      action: 'ok' | 'compress' | 'kill' | 'sanitize' | 'strip' | 'warn';
      detail?: string;
      timestamp: number;
    }
  | {
      type: 'verify';
      ok: boolean;
      failed?: VerifyCheck;
      reason?: string;
      timestamp: number;
    }
  | {
      type: 'error';
      code: AegisErrorCode;
      message: string;
      timestamp: number;
    };

export type UsageRecord = {
  conversationId: string;
  mode: AegisMode;
  language: 'de' | 'en';
  modelUsed: ModelId;
  iterations: number;
  toolsCalled: number;
  cost: CostBreakdown;
  verifyOk: boolean;
  startedAt: string; // ISO 8601
  completedAt: string; // ISO 8601
  durationMs: number;
};

// ───────────────────────── Response ─────────────────────────

export type AegisResponse = {
  text: string;
  citations: string[];
  conversationId: string;
  modelUsed: ModelId;
  iterations: number;
  toolCalls: Array<{ name: ToolName; input: unknown; resultPreview: string }>;
  cost: CostBreakdown;
  verify: VerifyResult;
  /**
   * Whether this turn was written to conversation memory. False when the run
   * is stateless (no session) or the memory write failed (fail-open) — the
   * UI uses it to warn that the turn may not survive a reload.
   */
  persisted: boolean;
  /**
   * Set on graceful degradation. `'iteration'`/`'cost'` (3.1): the answer was
   * forced out near the iteration ceiling or cost cap, so it may be incomplete.
   * `'verify'`: the report was complete but citation verification could not
   * finish in the remaining wall-clock, so it is shown with an explicit
   * "Verifizierung unvollständig" banner instead of timing out — never a
   * "verified success" (`verify.ok` stays false). Undefined on a clean finish.
   */
  degraded?: 'iteration' | 'cost' | 'verify';
};

// ───────────────────────── Errors ─────────────────────────

export type AegisErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'rate_limited'
  | 'verify_failed'
  | 'iteration_limit'
  | 'cost_limit'
  | 'upstream_error'
  | 'internal_error';

const ERROR_STATUS: Record<AegisErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  rate_limited: 429,
  verify_failed: 422,
  iteration_limit: 408,
  cost_limit: 402,
  upstream_error: 502,
  internal_error: 500,
};

export class AegisError extends Error {
  public readonly httpStatus: number;
  constructor(
    public readonly code: AegisErrorCode,
    message: string,
    public readonly conversationId?: string,
  ) {
    super(message);
    this.name = 'AegisError';
    this.httpStatus = ERROR_STATUS[code];
  }
}

// ───────────────────────── Guardrail outcomes ─────────────────────────

/**
 * Discriminated union of every possible guardrail outcome across both phases.
 * Consumers (the loop) `switch` on `action` to decide what to do next.
 *
 * - `ok`: proceed unchanged.
 * - `compress`: history is too long; loop must compress before next Claude call.
 * - `sanitize`: input contained a prompt-injection pattern; use `sanitizedMessage` instead.
 * - `kill`: hard stop — throw `AegisError` with the matching code.
 * - `strip`: response contained banned phrases; use `text` (cleaned).
 * - `warn`: response is acceptable but has soft issues (e.g. uncited article ref).
 * - `fail`: response is empty/invalid; outer loop must retry.
 */
export type GuardrailCheckResult =
  | { action: 'ok' }
  | { action: 'compress'; reason: string }
  | { action: 'sanitize'; sanitizedMessage: string; matched: string[] }
  | { action: 'kill'; code: 'iteration_limit' | 'cost_limit'; detail: string }
  | { action: 'strip'; text: string; stripped: string[]; warnings: string[] }
  | { action: 'warn'; text: string; warnings: string[] }
  | { action: 'fail'; reason: string };

// ───────────────────────── Guardrail config ─────────────────────────

export type GuardrailConfig = {
  /** Inner-loop iteration ceiling (text/standard channel). */
  maxIterations: number;
  /** Inner-loop iteration ceiling for voice channel (Phase 3). */
  voiceMaxIterations: number;
  /** Hard cost ceiling per conversation, in USD. */
  maxCostUsd: number;
  /**
   * Compaction trigger: when the **last prompt's input-token total** (the
   * current context-window size) exceeds this, compress. Token-based rather
   * than message-count so it fires on actual window size — large tool results
   * trigger it sooner, many tiny turns don't trigger it pointlessly.
   */
  maxContextTokens: number;
  /**
   * Soft budget for the resume seed loaded from a persisted conversation
   * (estimated tokens). Leaves headroom under `maxContextTokens` for tool
   * results and generation. Soft: a seed that still exceeds it after
   * selection goes through pre-flight compaction rather than being cut.
   */
  seedTokenBudget: number;
  /** Outer-loop attempt ceiling on verify failure. */
  maxOuterAttempts: number;
  /** Input-side patterns: sanitize on match. */
  bannedInputPatterns: RegExp[];
  /** Output-side patterns: strip matching sentences from response. */
  bannedOutputPatterns: RegExp[];
  /** Citation warning pattern: article reference without [R-...] in the same paragraph. */
  citationWarningPattern: RegExp;
  /** Verify rejects responses shorter than this many trimmed characters. */
  minResponseLength: number;
};

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxIterations: 10,
  voiceMaxIterations: 5,
  maxCostUsd: 10.0,
  // Context-window limits come from the centralized MemoryConfig (single source
  // of truth). Production defaults: auto-compaction at 150K, seed budget 100K —
  // sized for long-running regulatory projects, well under the model window.
  maxContextTokens: MemoryConfig.autoCompactionTokens,
  seedTokenBudget: MemoryConfig.seedBudgetTokens,
  maxOuterAttempts: 3,
  bannedInputPatterns: [
    /ignore previous instructions/i,
    /ignore all (prior |previous )?rules/i,
    /^\s*system\s*:/im,
  ],
  bannedOutputPatterns: [
    /\b(rechtsberatung|legal advice|rechtsverbindlich)\b/gi,
    /\bI recommend you should\b/gi,
    /\bI strongly advise\b/gi,
  ],
  citationWarningPattern: /(?<!\w)(Art\.|§|Rz\.|Kap\.)\s*\d/,
  minResponseLength: 10,
};
