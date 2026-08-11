import { CostAccumulator } from './context/cost';
import { PRICING_VERSION } from './types';
import { logUsage } from './usage-logger';

/**
 * Owns the per-run `CostAccumulator` plus the metadata needed to build a usage
 * row, and writes that row exactly once.
 *
 * Why this exists: the loop only reached a clean terminal state on the happy
 * path, so any conversation that errored, hit the cost cap, exhausted verify
 * retries, or was aborted mid-stream logged **nothing** — even though every
 * Claude call inside it was billed. The route now owns one recorder, hands its
 * accumulator to the loop, and `flush()`es it from a `finally`/`cancel`, so the
 * billed-but-unfinished runs are captured too.
 *
 * `flush()` is idempotent (guarded by `logged`) and a no-op when no Claude call
 * was ever recorded — so validation errors that never hit the API write no row.
 */
export type UsageRecorderMeta = {
  conversationId: string;
  mode: string;
  model: string;
  /** Provider that served the run. Defaults to "anthropic" (the historical brain). */
  provider: string;
  language: string;
  iterations: number;
  toolCalls: number;
  verifyPassed: boolean;
  citationCount: number;
  /**
   * How the run ended. Defaults to "aborted": every normal exit (success or a
   * caught error) overwrites it, so the default only survives when the stream
   * was cancelled mid-flight and flushed from `cancel()`.
   */
  exitReason: string;
  /** Distinct served models seen this run (for the `servedModel` column). */
  servedModels: string[];
  /** Guard-action tokens that fired (for the `guardrailsTriggered` column). */
  guardrailsTriggered: string[];
};

export class UsageRecorder {
  readonly cost = new CostAccumulator();
  private logged = false;
  private readonly meta: UsageRecorderMeta = {
    conversationId: '',
    mode: 'unknown',
    model: '',
    provider: 'anthropic',
    language: 'de',
    iterations: 0,
    toolCalls: 0,
    verifyPassed: false,
    citationCount: 0,
    exitReason: 'aborted',
    servedModels: [],
    guardrailsTriggered: [],
  };

  constructor(
    /** Public: conversation memory joins messages to usage rows via this id. */
    readonly traceId: string,
    private readonly kbVersion: string,
  ) {}

  setMeta(partial: Partial<UsageRecorderMeta>): void {
    Object.assign(this.meta, partial);
  }

  /** True once at least one Claude call has been recorded. */
  private hasUsage(): boolean {
    return this.cost.entries().length > 0;
  }

  /**
   * Persist the accumulated usage. Safe to call multiple times and from any
   * exit path — only the first call with recorded usage writes a row.
   */
  flush(latencyMs: number): void {
    if (this.logged || !this.hasUsage()) return;
    this.logged = true;

    const bd = this.cost.breakdown();
    void logUsage({
      traceId: this.traceId,
      conversationId: this.meta.conversationId || this.traceId,
      mode: this.meta.mode,
      model: this.meta.model || 'unknown',
      language: this.meta.language,
      inputTokens: bd.inputTokens,
      outputTokens: bd.outputTokens,
      cachedTokens: bd.cachedTokens,
      cacheCreationTokens: bd.cacheCreationTokens,
      provider: this.meta.provider || 'anthropic',
      priceStatus: bd.status,
      // Authoritative attribution: null cost for subscription/unknown runs — never
      // a fabricated figure. Priced runs carry the accumulated cents.
      costCents: bd.costCents,
      pricingVersion: PRICING_VERSION,
      exitReason: this.meta.exitReason,
      latencyMs: Math.max(0, Math.round(latencyMs)),
      iterations: this.meta.iterations,
      toolCalls: this.meta.toolCalls,
      verifyPassed: this.meta.verifyPassed,
      citationCount: this.meta.citationCount,
      // Distinct served models, joined; null when nothing was recorded.
      servedModel: this.meta.servedModels.length
        ? this.meta.servedModels.join(',')
        : null,
      guardrailsTriggered: this.meta.guardrailsTriggered,
      kbVersion: this.kbVersion,
    });
  }
}
