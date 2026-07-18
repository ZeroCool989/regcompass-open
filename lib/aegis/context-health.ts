/**
 * Context Health — a signal-density measure of conversation context quality.
 *
 * This is deliberately NOT a token-utilization gauge. Anthropic's guidance
 * ("Effective context engineering for AI agents") is explicit: there is no
 * recommended utilization percentage, quality degradation is "a performance
 * gradient rather than a hard cliff" ("context rot"), and good context
 * engineering means finding "the smallest possible set of high-signal tokens".
 * So we measure SIGNAL QUALITY, not fullness.
 *
 * For Aegis specifically the model has a 1M-token window with server-side
 * compaction at ~150K, while conversations are tiny — so utilization is almost
 * never the binding constraint. The real degradation risk is signal dilution
 * from repeated dialogue and large tool/KB dumps crowding out high-signal
 * tokens. The score reflects that.
 *
 * Pure + dependency-free so it runs on the client (over the chat store) and is
 * unit-testable. The weights/landmarks are operational defaults to calibrate,
 * not Anthropic-blessed constants — the UI says as much.
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
  /** Traffic-light band for `fullnessPct` (low = green … high = red). */
  fullnessBand: FullnessBand;
  /** Per-factor penalties, 0 (great) – 1 (bad), for the UI breakdown. */
  factors: {
    redundancy: number;
    toolLoad: number;
    signalDensity: number; // 0 (diluted) – 1 (dense); higher is better
    openLoops: number;
    utilization: number;
  };
}

// Landmarks derived from the REAL server-side compaction trigger in the central
// MemoryConfig (not a guessed fraction of the model window), so the gauge always
// matches the actual architecture. Utilization only contributes near the edge.
export const COMPACT_TRIGGER = MemoryConfig.autoCompactionTokens;
/** Utilization starts to count from 80% of the trigger… */
const UTIL_GATE = Math.round(COMPACT_TRIGGER * 0.8);
/** …and a "hard compact" recommendation kicks in at ~93% of the trigger. */
const HARD_TOKENS = Math.round(COMPACT_TRIGGER * 0.93);
/** Rough chars→tokens for German prose when no real token count is available. */
const CHARS_PER_TOKEN = MemoryConfig.charsPerTokenDe;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Lowercased word set of length ≥ 3 — cheap content fingerprint for overlap. */
function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) out.add(w);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Redundancy: mean of each turn's strongest similarity to an EARLIER same-role
 * turn (within a sliding window). High when the conversation keeps restating
 * the same things — wasted attention budget.
 */
function redundancyPenalty(turns: HealthTurn[]): number {
  const sets = turns.map((t) => ({ role: t.role, set: wordSet(t.content) }));
  const sims: number[] = [];
  const WINDOW = 6;
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].set.size < 4) continue;
    let best = 0;
    for (let j = Math.max(0, i - WINDOW); j < i; j++) {
      if (sets[j].role !== sets[i].role) continue;
      best = Math.max(best, jaccard(sets[i].set, sets[j].set));
    }
    sims.push(best);
  }
  if (sims.length === 0) return 0;
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  // Similarities above ~0.5 are clearly repetitive; scale so 0.5 ≈ full penalty.
  return clamp01(mean / 0.5);
}

/**
 * Tool-output load: tool calls accumulate KB/verify dumps that dilute the
 * answer signal. Penalty grows with tool calls per assistant turn.
 */
function toolLoadPenalty(turns: HealthTurn[]): number {
  const assistant = turns.filter((t) => t.role === 'aegis');
  if (assistant.length === 0) return 0;
  const totalTools = assistant.reduce((n, t) => n + (t.toolCallCount ?? 0), 0);
  // ~4 tool calls per assistant turn is heavy; scale to full penalty there.
  return clamp01(totalTools / (assistant.length * 4));
}

/**
 * Open loops: trailing user turns with no assistant answer yet, plus a small
 * nudge for many unanswered questions. A risk signal (compaction must preserve
 * these), not pure dilution — hence its low weight.
 */
function openLoopPenalty(turns: HealthTurn[]): number {
  let trailingUser = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'aegis') break;
    if (turns[i].role === 'user') trailingUser++;
  }
  return clamp01(trailingUser / 3);
}

function estimateTokens(turns: HealthTurn[]): number {
  // Real context size ≈ uncached input + cache-read tokens for a turn. Using
  // inputTokens alone undercounts badly once prompt caching kicks in (cached
  // reads are reported separately). Take the peak across turns.
  let reported = 0;
  for (const t of turns) {
    const total = (t.inputTokens ?? 0) + (t.cachedTokens ?? 0);
    if (total > reported) reported = total;
  }
  if (reported > 0) return reported;
  const chars = turns.reduce((n, t) => n + t.content.length, 0);
  return Math.round(chars / CHARS_PER_TOKEN);
}

function bandFor(score: number): HealthBand {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'attention';
  return 'compress';
}

/** Fullness → traffic light. Green with plenty of room, red as it fills up. */
export function fullnessBand(pct: number): FullnessBand {
  if (pct < 60) return 'low';
  if (pct < 85) return 'mid';
  return 'high';
}

export function computeContextHealth(turns: HealthTurn[]): ContextHealth {
  const real = turns.filter((t) => t.role !== 'error');
  const approxTokens = estimateTokens(real);

  const redundancy = redundancyPenalty(real);
  const toolLoad = toolLoadPenalty(real);
  const signalDensity = clamp01(1 - (redundancy + toolLoad) / 2);
  const openLoops = openLoopPenalty(real);
  const utilization =
    approxTokens <= UTIL_GATE
      ? 0
      : clamp01((approxTokens - UTIL_GATE) / (COMPACT_TRIGGER - UTIL_GATE));

  const penalty =
    0.35 * redundancy +
    0.25 * toolLoad +
    0.2 * (1 - signalDensity) +
    0.1 * openLoops +
    0.1 * utilization;

  const score = Math.round(clamp01(1 - penalty) * 100);
  const band = bandFor(score);

  // Fullness is token utilisation toward the compaction trigger (the practical
  // "full"). 0 = empty/green, 100 = at the limit/red.
  const fullnessPct = Math.round(clamp01(approxTokens / COMPACT_TRIGGER) * 100);

  const recommendCompaction: CompactionAdvice =
    score < 40 || approxTokens > HARD_TOKENS
      ? 'hard'
      : score < 60 || approxTokens > UTIL_GATE
        ? 'soft'
        : 'none';

  return {
    score,
    band,
    recommendCompaction,
    approxTokens,
    fullnessPct,
    fullnessBand: fullnessBand(fullnessPct),
    factors: { redundancy, toolLoad, signalDensity, openLoops, utilization },
  };
}
