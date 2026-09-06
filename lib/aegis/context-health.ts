/**
 * Context Health — a simple fullness gauge for the conversation context window.
 *
 * Measures how close the context is to the auto-compaction trigger and recommends
 * compaction accordingly. Pure + dependency-free so it runs on the client (over
 * the chat store) and is unit-testable.
 */

import { MemoryConfig } from './memory-config';

export type HealthBand = 'excellent' | 'good' | 'attention' | 'compress';
export type CompactionAdvice = 'none' | 'soft' | 'hard';

export interface HealthTurn {
  role: 'user' | 'aegis' | 'error';
  content: string;
  /** Number of tool calls this turn made (assistant turns); 0 otherwise. */
  toolCallCount?: number;
  /** Anthropic-reported UNCACHED input tokens for this turn. NOTE: with prompt
   *  caching this is only the remainder — the bulk of the context is reported
   *  separately as `cachedTokens` (cache_read). Context size ≈ the two summed. */
  inputTokens?: number;
  /** Cache-read tokens for this turn (cache_read_input_tokens). */
  cachedTokens?: number;
}

/** Context-window fullness band — higher fullness is worse (full = red). */
export type FullnessBand = 'low' | 'mid' | 'high';

export interface ContextHealth {
  score: number; // 0–100
  band: HealthBand;
  recommendCompaction: CompactionAdvice;
  /** Approximate current context size in tokens (real if reported, else estimated). */
  approxTokens: number;
  /**
   * How full the working context window is, 0–100. 100 = at the compaction
   * trigger (the practical "full"). Unlike `score`, HIGHER IS WORSE — this is
   * the intuitive "the bar fills up and turns red as context fills" gauge.
   */
  fullnessPct: number;
  /** Traffic-light band for `fullnessPct` (low = green ... high = red). */
  fullnessBand: FullnessBand;
  /** Kept for backward compatibility; all zeroed. */
  factors: {
    redundancy: number;
    toolLoad: number;
    signalDensity: number;
    openLoops: number;
    utilization: number;
  };
}

// Landmarks derived from the REAL server-side compaction trigger in the central
// MemoryConfig, so the gauge always matches the actual architecture.
export const COMPACT_TRIGGER = MemoryConfig.autoCompactionTokens;
/** Soft-compact recommendation kicks in at 80% of the trigger. */
const SOFT_TOKENS = Math.round(COMPACT_TRIGGER * 0.8);
/** Hard-compact recommendation kicks in at ~93% of the trigger. */
const HARD_TOKENS = Math.round(COMPACT_TRIGGER * 0.93);
/** Rough chars->tokens for German prose when no real token count is available. */
const CHARS_PER_TOKEN = MemoryConfig.charsPerTokenDe;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function estimateTokens(turns: HealthTurn[]): number {
  // Real context size = uncached input + cache-read tokens. Take peak across turns.
  let reported = 0;
  for (const t of turns) {
    const total = (t.inputTokens ?? 0) + (t.cachedTokens ?? 0);
    if (total > reported) reported = total;
  }
  if (reported > 0) return reported;
  const chars = turns.reduce((n, t) => n + t.content.length, 0);
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Fullness -> traffic light. Green with plenty of room, red as it fills up. */
export function fullnessBand(pct: number): FullnessBand {
  if (pct < 60) return 'low';
  if (pct < 85) return 'mid';
  return 'high';
}

export function computeContextHealth(turns: HealthTurn[]): ContextHealth {
  const real = turns.filter((t) => t.role !== 'error');
  const approxTokens = estimateTokens(real);

  // Fullness is token utilisation toward the compaction trigger.
  // 0 = empty/green, 100 = at the limit/red.
  const fullnessPct = Math.round(clamp01(approxTokens / COMPACT_TRIGGER) * 100);

  // Score = inverse of fullness (100 when empty, 0 when full).
  const score = Math.max(0, 100 - fullnessPct);
  const band: HealthBand =
    score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'attention' : 'compress';

  const recommendCompaction: CompactionAdvice =
    approxTokens > HARD_TOKENS
      ? 'hard'
      : approxTokens > SOFT_TOKENS
        ? 'soft'
        : 'none';

  return {
    score,
    band,
    recommendCompaction,
    approxTokens,
    fullnessPct,
    fullnessBand: fullnessBand(fullnessPct),
    factors: { redundancy: 0, toolLoad: 0, signalDensity: 1, openLoops: 0, utilization: 0 },
  };
}
