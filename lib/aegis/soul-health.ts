/**
 * Soul Memory Governance (Phase 3.1) — keeps the personalization set healthy:
 * non-contradictory, de-duplicated, fresh, and corroborated. Pure + dependency
 * free so it runs on the client and is fully unit-testable.
 *
 * Heuristic by design (deterministic, no model call). Contradiction detection
 * uses opposing "preference axes" within a section; an LLM judge is a future
 * enhancement. The user always decides — governance flags, it never deletes.
 */

export type LifecycleStage = 'active' | 'aging' | 'archived';

export interface GovEntry {
  id: string;
  section: string;
  content: string;
  signalCount?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
  usedCount?: number;
  /** ISO string or epoch ms. */
  lastConfirmedAt?: string | number | Date;
}

/** A preference not re-confirmed within this many days is "aging". */
export const AGING_DAYS = 90;
/** Freshness fully decays by this age. */
const STALE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Lexical-similarity threshold above which two entries are "duplicates". */
export const DUPLICATE_THRESHOLD = 0.6;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

function ageDays(value: GovEntry['lastConfirmedAt'], now: number): number {
  if (value == null) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / DAY_MS);
}

export function deriveStage(entry: GovEntry, now: number = Date.now()): LifecycleStage {
  if (entry.status === 'ARCHIVED') return 'archived';
  return ageDays(entry.lastConfirmedAt, now) > AGING_DAYS ? 'aging' : 'active';
}

// ───────────────────────── Duplicate detection ─────────────────────────

function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) out.add(w);
  return out;
}

export function similarity(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface DuplicatePair {
  a: string;
  b: string;
  score: number;
}

/** Duplicate/near-duplicate pairs among the given entries (by id). */
export function findDuplicates(
  entries: GovEntry[],
  threshold = DUPLICATE_THRESHOLD,
): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const score = similarity(entries[i].content, entries[j].content);
      if (score >= threshold) pairs.push({ a: entries[i].id, b: entries[j].id, score });
    }
  }
  return pairs;
}

// ───────────────────────── Contradiction detection ─────────────────────────

/** Opposing preference axes — a pair on opposite poles in one section conflicts. */
// Prefix/stem matching (no trailing \b) so German inflections — "knappe",
// "ausführliche", "Beispiele" — match their stem.
const AXES: Array<{ name: string; a: RegExp; b: RegExp }> = [
  { name: 'Länge', a: /\b(knapp|kurz|präg|kompakt|concise|brief)/i, b: /\b(ausführ|detail|ausgiebig|umfassend)/i },
  { name: 'Fokus', a: /\b(umsetzung|implementier|praktisch|konkret|hands-?on)/i, b: /\b(theorie|theoret|hintergrund|konzept|grundlag)/i },
  { name: 'Ton', a: /\b(formell|förmlich|formal|sachlich)/i, b: /\b(locker|informell|casual|salopp)/i },
  { name: 'Erklärweise', a: /\b(beispiel|example)/i, b: /\b(abstrakt|definition)/i },
  { name: 'Format', a: /\b(tabelle|stichpunkt|liste|bullet)/i, b: /\b(fliesstext|prosa|absätz|narrativ)/i },
];

function axisPolarity(text: string, axis: (typeof AXES)[number]): 'a' | 'b' | null {
  const a = axis.a.test(text);
  const b = axis.b.test(text);
  if (a && !b) return 'a';
  if (b && !a) return 'b';
  return null;
}

/** Does a candidate contradict an existing entry? Same section, opposite pole. */
export function contradicts(candidate: string, existing: string): { axis: string } | null {
  for (const axis of AXES) {
    const pc = axisPolarity(candidate, axis);
    const pe = axisPolarity(existing, axis);
    if (pc && pe && pc !== pe) return { axis: axis.name };
  }
  return null;
}

export interface ContradictionPair {
  a: string;
  b: string;
  axis: string;
}

/** All contradicting pairs among same-section entries. */
export function detectContradictions(entries: GovEntry[]): ContradictionPair[] {
  const out: ContradictionPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].section !== entries[j].section) continue;
      const c = contradicts(entries[i].content, entries[j].content);
      if (c) out.push({ a: entries[i].id, b: entries[j].id, axis: c.axis });
    }
  }
  return out;
}

/** First active entry that contradicts `candidate` in `section`, or null. */
export function findConflict(
  candidate: string,
  section: string,
  active: GovEntry[],
): { entry: GovEntry; axis: string } | null {
  for (const e of active) {
    if (e.section !== section) continue;
    const c = contradicts(candidate, e.content);
    if (c) return { entry: e, axis: c.axis };
  }
  return null;
}

// ───────────────────────── Memory Health Score ─────────────────────────

export interface MemoryHealth {
  score: number; // 0–100
  band: 'excellent' | 'good' | 'attention' | 'poor';
  factors: {
    consistency: number; // 0–1 (higher better)
    freshness: number;
    corroboration: number;
    usefulness: number;
    duplicates: number; // 0–1 (higher = more duplication, worse)
  };
  contradictionCount: number;
  duplicateCount: number;
  agingCount: number;
}

function freshnessScore(days: number): number {
  if (days <= AGING_DAYS) return 1;
  if (days >= STALE_DAYS) return 0.3;
  // linear 1.0 → 0.3 between AGING_DAYS and STALE_DAYS
  return 1 - (0.7 * (days - AGING_DAYS)) / (STALE_DAYS - AGING_DAYS);
}

/**
 * Memory Health over the ACTIVE set (archived entries don't affect the live
 * personalization, so callers pass active entries). Empty = 100 (nothing to rot).
 */
export function computeMemoryHealth(
  active: GovEntry[],
  now: number = Date.now(),
): MemoryHealth {
  if (active.length === 0) {
    return {
      score: 100,
      band: 'excellent',
      factors: { consistency: 1, freshness: 1, corroboration: 1, usefulness: 1, duplicates: 0 },
      contradictionCount: 0,
      duplicateCount: 0,
      agingCount: 0,
    };
  }

  const contradictionPairs = detectContradictions(active);
  const duplicatePairs = findDuplicates(active);
  const agingCount = active.filter((e) => deriveStage(e, now) === 'aging').length;

  const consistency = clamp01(1 - contradictionPairs.length / active.length);
  const freshness =
    active.reduce((s, e) => s + freshnessScore(ageDays(e.lastConfirmedAt, now)), 0) / active.length;
  const corroboration =
    active.reduce((s, e) => s + Math.min(5, e.signalCount ?? 1) / 5, 0) / active.length;
  const usefulness =
    active.reduce((s, e) => s + Math.min(10, e.usedCount ?? 0) / 10, 0) / active.length;
  const duplicates = clamp01(duplicatePairs.length / active.length);

  const score = Math.round(
    100 *
      clamp01(
        0.3 * consistency +
          0.2 * freshness +
          0.2 * corroboration +
          0.15 * usefulness +
          0.15 * (1 - duplicates),
      ),
  );
  const band =
    score >= 85 ? 'excellent' : score >= 65 ? 'good' : score >= 45 ? 'attention' : 'poor';

  return {
    score,
    band,
    factors: { consistency, freshness, corroboration, usefulness, duplicates },
    contradictionCount: contradictionPairs.length,
    duplicateCount: duplicatePairs.length,
    agingCount,
  };
}
