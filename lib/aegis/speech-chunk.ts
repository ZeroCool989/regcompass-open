/**
 * Speech chunker for Voice Mode (Phase 1.5).
 *
 * `extractSentences` answers "where does a sentence end?". This module answers a
 * different question — "what is a natural unit to SPEAK now?" — because humans
 * pause far more often than grammar requires. It composes the sentence splitter
 * (inheriting its citation / abbreviation / decimal guards) and then subdivides
 * each piece at speech-friendly pauses so long structured answers start playing
 * much sooner.
 *
 * Boundaries, in addition to . ! ? … (from extractSentences):
 *   - colon / semicolon (": " / "; ")
 *   - newlines & blank lines (bullet and numbered lists, markdown headings)
 *   - ordinal cues ("Erstens…", "Zweitens…", "First,", "Second,")
 *   - and, for over-long units, the nearest comma / dash / space — falling back
 *     to a hard character cut only when no natural pause exists.
 *
 * Pure (no React/DOM) so it is fully unit-tested. Cleaning (stripForVoice) still
 * happens later in the component, so chunks keep their punctuation here.
 */

import { extractSentences } from './sentence';

/** Above this length a unit is broken at the nearest natural pause. */
export const SPEECH_CHUNK_MAX = 160;
/** Don't emit pieces shorter than this when length-splitting (avoids slivers). */
const MIN_SPLIT = 40;
/**
 * Adaptive early flush (streaming): once the still-incomplete tail reaches
 * TARGET with no sentence boundary in sight, speak it at the nearest natural
 * pause instead of waiting for a period. HARD is the absolute last resort — a
 * forced word-boundary cut only when no natural pause exists anywhere.
 */
const EARLY_FLUSH_TARGET = 130;
const EARLY_FLUSH_HARD = 200;
/** Clause-joining words a human presenter naturally pauses BEFORE. */
const CONJUNCTIONS = [
  'and', 'but', 'because', 'however', 'therefore', 'moreover', 'so',
  'und', 'aber', 'jedoch', 'deshalb', 'weil', 'denn', 'sondern', 'oder',
];
const CONJUNCTION_RE = new RegExp(`\\s(?:${CONJUNCTIONS.join('|')})\\s`, 'gi');

/** True if index `idx` sits inside an unclosed "[...]" (e.g. half-streamed [R-…]). */
function citationOpenAt(text: string, idx: number): boolean {
  let open = 0;
  for (let k = 0; k < idx; k++) {
    if (text[k] === '[') open++;
    else if (text[k] === ']' && open > 0) open--;
  }
  return open > 0;
}

// Break BEFORE an ordinal cue that starts a new clause. German "-ens" forms are
// unambiguous; English ordinals require a trailing comma to avoid "First Lady".
const ORDINAL_DE = /(?<=\S)\s+(?=(?:erstens|zweitens|drittens|viertens|fünftens|sechstens)\b)/giu;
const ORDINAL_EN = /(?<=\S)\s+(?=(?:first|second|third|fourth|fifth)(?:ly)?,)/gi;

function splitAtOrdinals(seg: string): string[] {
  const out: string[] = [];
  for (const a of seg.split(ORDINAL_DE)) {
    out.push(...a.split(ORDINAL_EN));
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Split a single line at ": " / "; ", keeping the delimiter on the left part. */
function splitHard(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (
      (ch === ':' || ch === ';') &&
      /\s/.test(line[i + 1] ?? '') &&
      !citationOpenAt(line, i)
    ) {
      const seg = line.slice(start, i + 1).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
  }
  const tail = line.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/** Latest conjunction within [lo,hi] to pause BEFORE; end-exclusive cut or null. */
function conjunctionCut(s: string, lo: number, hi: number): number | null {
  let best: number | null = null;
  CONJUNCTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONJUNCTION_RE.exec(s)) !== null) {
    const at = m.index; // the whitespace just before the conjunction word
    if (at >= lo && at <= hi && !citationOpenAt(s, at)) best = at;
    CONJUNCTION_RE.lastIndex = m.index + 1; // allow overlapping matches
  }
  return best;
}

/**
 * Nearest natural speech pause within [lo,hi], end-exclusive. Priority mirrors
 * where a human presenter pauses: colon › semicolon › dash › comma › newline ›
 * conjunction. Within a type the LATEST position wins (longer, less choppy
 * chunks). Citation-safe; punctuation must be followed by whitespace.
 */
function naturalPauseCut(s: string, lo: number, hi: number): number | null {
  hi = Math.min(hi, s.length - 1);
  if (hi < lo) return null;
  const scan = (pred: (i: number) => number | null): number | null => {
    for (let i = hi; i >= lo; i--) {
      if (citationOpenAt(s, i)) continue;
      const c = pred(i);
      if (c != null) return c;
    }
    return null;
  };
  // colon, then semicolon
  let c =
    scan((i) => (s[i] === ':' && isSpace(s[i + 1]) ? i + 1 : null)) ??
    scan((i) => (s[i] === ';' && isSpace(s[i + 1]) ? i + 1 : null));
  if (c != null) return c;
  // dash: em / en always; a plain hyphen only when space-surrounded (so it is a
  // real dash, not part of "IT-Resilienz" or a citation id).
  c = scan((i) => {
    if ((s[i] === '—' || s[i] === '–') && isSpace(s[i + 1])) return i + 1;
    if (s[i] === '-' && isSpace(s[i - 1]) && isSpace(s[i + 1])) return i + 1;
    return null;
  });
  if (c != null) return c;
  // comma, then newline
  c =
    scan((i) => (s[i] === ',' && isSpace(s[i + 1]) ? i + 1 : null)) ??
    scan((i) => (s[i] === '\n' ? i : null));
  if (c != null) return c;
  // conjunction (lowest priority)
  return conjunctionCut(s, lo, hi);
}

/** Forced word-boundary cut for the last-resort case (no natural pause at all). */
function hardWordCut(s: string, max: number): number {
  const hi = Math.min(max, s.length - 1);
  for (let i = hi; i >= MIN_SPLIT; i--) {
    if (citationOpenAt(s, i)) continue;
    if (/\s/.test(s[i])) return i;
  }
  return Math.min(max, s.length);
}

/** Choose an end-exclusive cut for an over-long COMPLETE unit. */
function findCut(s: string): number {
  return naturalPauseCut(s, MIN_SPLIT, SPEECH_CHUNK_MAX) ?? hardWordCut(s, SPEECH_CHUNK_MAX);
}

function splitLong(text: string): string[] {
  let s = text.trim();
  if (s.length <= SPEECH_CHUNK_MAX) return s ? [s] : [];
  const out: string[] = [];
  while (s.length > SPEECH_CHUNK_MAX) {
    const cut = findCut(s);
    const left = s.slice(0, cut).trim();
    if (left) out.push(left);
    s = s.slice(cut).replace(/^\s+/, '');
  }
  if (s) out.push(s);
  return out;
}

/**
 * Split a COMPLETE piece of text into natural speech units. Short, plain
 * sentences pass through unchanged (so short answers behave exactly as before).
 */
export function chunkText(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue; // blank line = separator
    for (const hard of splitHard(line)) {
      for (const ord of splitAtOrdinals(hard)) {
        out.push(...splitLong(ord));
      }
    }
  }
  return out;
}

/**
 * Emit speech units from the still-incomplete trailing sentence — but ONLY ones
 * we are confident are final: a ": "/"; " or newline already seen, or (once the
 * tail is long enough) the nearest natural pause that is already followed by
 * whitespace. Anything not yet confidently closed stays in `rest`.
 */
function streamSecondary(text: string): { emitted: string[]; rest: string } {
  const emitted: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isColon =
      (ch === ':' || ch === ';') &&
      /\s/.test(text[i + 1] ?? '') &&
      !citationOpenAt(text, i);
    const isNl = ch === '\n';
    if (!isColon && !isNl) continue;
    const unit = text.slice(start, isColon ? i + 1 : i).trim();
    if (unit) emitted.push(...chunkText(unit));
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    start = j;
    i = j - 1;
  }
  let lead = text.slice(start);
  // Adaptive early flush: once the tail is long enough, speak it at the nearest
  // natural pause; force a word-cut only as an absolute last resort.
  while (lead.length >= EARLY_FLUSH_TARGET) {
    const cut = naturalPauseCut(lead, MIN_SPLIT, Math.min(SPEECH_CHUNK_MAX, lead.length - 1));
    if (cut != null) {
      const left = lead.slice(0, cut).trim();
      if (left) emitted.push(...chunkText(left));
      lead = lead.slice(cut).replace(/^\s+/, '');
      continue;
    }
    if (lead.length >= EARLY_FLUSH_HARD) {
      const hard = hardWordCut(lead, SPEECH_CHUNK_MAX);
      const left = lead.slice(0, hard).trim();
      if (left) emitted.push(...chunkText(left));
      lead = lead.slice(hard).replace(/^\s+/, '');
      continue;
    }
    break; // no natural pause yet and under the hard ceiling — wait for tokens
  }
  return { emitted, rest: lead };
}

/**
 * Streaming entry point — drop-in replacement for `extractSentences` in the
 * voice token handler. Returns every speech chunk that can be confidently spoken
 * from `buffer` now, plus the unfinished `rest` to re-feed with the next tokens.
 */
export function extractSpeechChunks(buffer: string): { chunks: string[]; rest: string } {
  const { sentences, rest: sentRest } = extractSentences(buffer);
  const chunks: string[] = [];
  for (const s of sentences) chunks.push(...chunkText(s));
  const { emitted, rest } = streamSecondary(sentRest);
  chunks.push(...emitted);
  return { chunks, rest };
}
