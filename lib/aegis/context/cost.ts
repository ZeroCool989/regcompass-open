import {
  MODEL_COSTS,
  lookupPricing,
  priceStatusFor,
  type CostBreakdown,
  type ModelId,
  type ModelProviderId,
  type ModelRef,
  type PriceStatus,
} from '../types';

/**
 * Resolves the attribution provider for a bare model id. Injected into
 * {@link CostAccumulator} so this module needs no dependency on provider
 * selection (which would create an import cycle). Defaults to Anthropic — the
 * historical single-brain behaviour — so a pure Anthropic run is unchanged.
 */
export type ProviderResolver = (model: string) => ModelProviderId;
const ANTHROPIC_ONLY: ProviderResolver = () => 'anthropic';

/**
 * The raw token-usage shape Anthropic returns on every message. Structurally
 * compatible with `Anthropic.Usage`, so a response's `usage` can be passed
 * straight through with **no destructuring** — that's deliberate: dropping the
 * cache buckets here is exactly what previously caused the dashboard to
 * under-report cost by ~4×.
 *
 * `input_tokens` is the FRESH (uncached) portion only; cache reads and cache
 * writes are reported in their own fields and billed at different rates.
 */
export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Per-TTL breakdown of cache writes, when the API provides it. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
};

/**
 * Cache-write tokens split by TTL.
 *
 * This codebase only ever sets `cache_control: { type: 'ephemeral' }` with no
 * `ttl` (see lib/aegis/client.ts) — i.e. the API default of 5 minutes. So in
 * practice the API returns no TTL breakdown and the all-5m fallback below is
 * exact, NOT an under-price. The 5m/1h split is honoured when present purely so
 * that adding a 1-hour breakpoint later prices correctly without touching this.
 */
function splitCacheWrites(usage: ClaudeUsage): { write5m: number; write1h: number } {
  const split = usage.cache_creation;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    return {
      write5m: split.ephemeral_5m_input_tokens ?? 0,
      write1h: split.ephemeral_1h_input_tokens ?? 0,
    };
  }
  // No TTL breakdown: `cache_creation_input_tokens` is the total, all at the
  // default 5-minute TTL, so price the whole bucket at the 5m write rate.
  return { write5m: usage.cache_creation_input_tokens ?? 0, write1h: 0 };
}

/**
 * Cost of a single Claude call in **cents** (fractional, not rounded).
 *
 * Prices every billable bucket the API reports: fresh input, output, cache
 * reads, and cache writes (with the 5m/1h TTL split when present). Throws on an
 * unknown model — it must NEVER silently return 0, which would hide real spend.
 */
export function computeCost(model: ModelId, usage: ClaudeUsage): number {
  const pricing = MODEL_COSTS[model];
  if (!pricing) {
    throw new Error(
      `computeCost: no pricing for model "${model}". Add it to MODEL_COSTS and bump PRICING_VERSION.`,
    );
  }

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const { write5m, write1h } = splitCacheWrites(usage);

  const usd =
    (usage.input_tokens / 1_000_000) * pricing.input +
    (usage.output_tokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (write5m / 1_000_000) * pricing.cacheWrite5m +
    (write1h / 1_000_000) * pricing.cacheWrite1h;

  return usd * 100;
}

/** Priced cost of one call, in cents, or null when no per-token rate applies. */
export type PricedResult = { costCents: number | null; status: PriceStatus };

/**
 * Provider-aware cost of a single call. Prices only when a rate is configured for
 * (provider, model); otherwise returns `costCents: null` with an explicit status
 * — `subscription_unpriced` for subscription brains, `pricing_unknown` for a
 * per-token provider with no configured rate. NEVER substitutes another
 * provider's rate, and never throws (unknown pricing is a first-class state).
 */
export function computeCostRef(ref: ModelRef, usage: ClaudeUsage): PricedResult {
  const pricing = lookupPricing(ref);
  if (!pricing) return { costCents: null, status: priceStatusFor(ref) };

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const { write5m, write1h } = splitCacheWrites(usage);
  const usd =
    (usage.input_tokens / 1_000_000) * pricing.input +
    (usage.output_tokens / 1_000_000) * pricing.output +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (write5m / 1_000_000) * pricing.cacheWrite5m +
    (write1h / 1_000_000) * pricing.cacheWrite1h;
  return { costCents: usd * 100, status: 'priced' };
}

export type CostEntry = {
  model: string;
  provider: ModelRef['provider'];
  /** Priced cents for this call, or null when unpriced (subscription/unknown). */
  cents: number | null;
  status: PriceStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export class CostAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private costCents = 0;
  private status: PriceStatus = 'priced';
  private readonly perCall: CostEntry[] = [];

  /**
   * @param resolveProvider maps a bare model id to its attribution provider.
   * Defaults to Anthropic-only so an unconfigured accumulator (and every existing
   * caller) prices exactly as before; the runtime injects the brain-aware resolver.
   */
  constructor(private resolveProvider: ProviderResolver = ANTHROPIC_ONLY) {}

  /**
   * Pin every subsequent `add()` to one provider — the request-scoped selection.
   * Dispatch honours the user's chosen provider over any `AEGIS_BRAIN` env
   * override, so attribution must follow the same provider (not the env). Called
   * once the selection is known; earlier calls keep their resolved provider.
   */
  pinProvider(provider: ModelProviderId): void {
    this.resolveProvider = () => provider;
  }

  /** Record one call by bare model id; the injected resolver supplies the provider. */
  add(model: ModelId, usage: ClaudeUsage): CostEntry {
    return this.addRef({ provider: this.resolveProvider(model), model }, usage);
  }

  /** Record one provider-qualified call; prices it or marks it unpriced. */
  addRef(ref: ModelRef, usage: ClaudeUsage): CostEntry {
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const { costCents, status } = computeCostRef(ref, usage);

    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.cacheReadTokens += cacheRead;
    this.cacheCreationTokens += cacheCreation;
    if (status === 'priced' && costCents != null) this.costCents += costCents;
    this.degrade(status);

    const entry: CostEntry = {
      model: ref.model,
      provider: ref.provider,
      cents: costCents,
      status,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
    };
    this.perCall.push(entry);
    return entry;
  }

  /** Worst-status-wins across a run: any unpriced call taints the run's total. */
  private degrade(status: PriceStatus): void {
    const rank: Record<PriceStatus, number> = { priced: 0, subscription_unpriced: 1, pricing_unknown: 2 };
    if (rank[status] > rank[this.status]) this.status = status;
  }

  /** The run's cost-attribution status (priced only if every call was priced). */
  priceStatus(): PriceStatus {
    return this.status;
  }

  /** Priced total in cents, or null when the run is not fully priced. */
  totalCentsOrNull(): number | null {
    return this.status === 'priced' ? this.costCents : null;
  }

  /** Total priced cost so far, in cents (fractional). Priced portion only. */
  total(): number {
    return this.costCents;
  }

  /** Total priced cost so far, in USD. Priced portion only. */
  totalUsd(): number {
    return this.costCents / 100;
  }

  /**
   * Aggregate breakdown. `costCents`/`status` are the authoritative attribution
   * (null cost when subscription/unknown); `usd` remains the priced-portion sum
   * for existing readouts.
   */
  breakdown(): CostBreakdown & { status: PriceStatus; costCents: number | null } {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      usd: this.costCents / 100,
      status: this.status,
      costCents: this.totalCentsOrNull(),
    };
  }

  /** Per-call detail (read-only view). Useful for telemetry / debugging. */
  entries(): readonly CostEntry[] {
    return this.perCall;
  }

  /**
   * The run's provider label for the persisted `provider` column: the sole
   * provider that served it, or `'mixed'` when more than one distinct provider
   * contributed. A mixed run is therefore never silently collapsed to a single
   * brand — and its cost is still correct because worst-status-wins already
   * taints `priceStatus`/`costCents` (any unpriced call → null cost). In the live
   * runtime a run is provider-uniform (the `AEGIS_BRAIN` override points every
   * call at one brain; absent an override every call is claude → anthropic), so
   * `'mixed'` is a defensive honesty guarantee for future multi-brain dispatch.
   * `anthropic` when nothing was recorded (matches the historical default).
   */
  providerLabel(): ModelProviderId | 'mixed' {
    const distinct = new Set<ModelProviderId>();
    for (const e of this.perCall) distinct.add(e.provider);
    if (distinct.size === 0) return 'anthropic';
    if (distinct.size > 1) return 'mixed';
    return [...distinct][0];
  }

  /**
   * Total input tokens of the **most recent** call's prompt — fresh input plus
   * cache reads plus cache writes — i.e. the current context-window size. `0`
   * before the first call (so iteration 0 never triggers token-budget
   * compaction). Drives the compaction trigger in the pre-guard.
   */
  currentContextTokens(): number {
    const last = this.perCall[this.perCall.length - 1];
    if (!last) return 0;
    return last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens;
  }
}
