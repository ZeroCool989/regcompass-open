/**
 * Soul Memory Governance — de-duplication and single-entry contradiction
 * checking for the personalization set. Pure + dependency-free so it runs on
 * the client and is fully unit-testable.
 *
 * Heuristic by design (deterministic, no model call). Contradiction detection
 * uses opposing "preference axes" within a section; an LLM judge is a future
 * enhancement. The user always decides — governance flags, it never deletes.
 */

export interface GovEntry {
  id: string;
  section: string;
  content: string;
  signalCount?: number;
  status?: 'ACTIVE' | 'ARCHIVED';
}

/** Lexical-similarity threshold above which two entries are "duplicates". */
export const DUPLICATE_THRESHOLD = 0.6;

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
