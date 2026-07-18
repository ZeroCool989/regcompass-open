/**
 * Streaming sentence splitter for Voice Mode (Phase 1).
 *
 * `extractSentences` is fed the growing tail of the LLM token stream and returns
 * every COMPLETE sentence it can confidently close, plus the still-incomplete
 * `rest` (which the caller keeps and re-feeds with the next tokens). It is the
 * one place that decides "this much can be spoken now", so it is deliberately
 * pure (no React, no DOM) and unit-tested.
 *
 * Conservative by design: a boundary is only emitted when a sentence-final
 * punctuation mark is followed by whitespace (or a newline boundary). A period
 * at the very end of the buffer is NOT a boundary yet — more tokens may turn it
 * into "3.1" or "z. B." — so we wait. False negatives only delay audio slightly;
 * false positives would speak a half-sentence, so we err toward waiting.
 */

// Abbreviations whose trailing period must NOT end a sentence. Single letters
// cover the spaced German forms "z. B.", "d. h.", "u. a.", "e. g.", "i. e.",
// "s. o." (each token is checked separately as the scan advances).
const ABBREVIATIONS = new Set([
  'dr', 'prof', 'mr', 'mrs', 'ms', 'art', 'abs', 'nr', 'bzw', 'usw', 'etc',
  'ca', 'vgl', 'lit', 'sog', 'inkl', 'evtl', 'ggf', 'max', 'min', 'tel',
  'z', 'b', 'd', 'h', 'u', 'a', 'o', 'e', 'g', 'i', 's',
]);

const TERMINALS = '.!?…';

/** True if the text (ending at a period) closes with a known abbreviation. */
function endsWithAbbrev(s: string): boolean {
  const m = /([A-Za-zÄÖÜäöü]+)\.?$/.exec(s.trimEnd());
  return m ? ABBREVIATIONS.has(m[1].toLowerCase()) : false;
}

export function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0; // index where the current (not-yet-emitted) sentence begins
  let i = 0;

  // Are we inside an unclosed "[...]" (e.g. a half-streamed [R-DORA-003])?
  const insideCitation = (upto: number): boolean => {
    let open = 0;
    for (let k = start; k < upto; k++) {
      if (buffer[k] === '[') open++;
      else if (buffer[k] === ']' && open > 0) open--;
    }
    return open > 0;
  };

  const emit = (endExclusive: number): number => {
    const sentence = buffer.slice(start, endExclusive).trim();
    if (sentence) sentences.push(sentence);
    let s = endExclusive;
    while (s < buffer.length && /\s/.test(buffer[s])) s++;
    start = s;
    return s;
  };

  while (i < buffer.length) {
    const ch = buffer[i];

    // Newline (incl. bullet lines) is a soft boundary on its own.
    if (ch === '\n') {
      if (!insideCitation(i)) {
        i = emit(i);
        continue;
      }
      i++;
      continue;
    }

    if (!TERMINALS.includes(ch)) {
      i++;
      continue;
    }

    // Consume a run of terminals ("?!", "...", "!?").
    let j = i;
    while (j + 1 < buffer.length && TERMINALS.includes(buffer[j + 1])) j++;
    const afterIdx = j + 1;
    const after = buffer[afterIdx];

    // Only a boundary if followed by whitespace. End-of-buffer → wait for more.
    if (after === undefined || !/\s/.test(after)) {
      i = afterIdx;
      continue;
    }

    // Don't split inside a citation.
    if (insideCitation(afterIdx)) {
      i = afterIdx;
      continue;
    }

    // Don't split after a leading enumeration marker like "1." / "2." — the
    // number sits at the very start of the current sentence, so the period is a
    // list marker that belongs to the item, not a sentence end. A number that
    // appears mid-sentence ("Das war 2020.") is NOT at `start`, so it still
    // splits normally.
    if (/^\d+$/.test(buffer.slice(start, i).trim())) {
      i = afterIdx;
      continue;
    }

    // Don't split after an abbreviation ("z. B.", "Art.").
    if (endsWithAbbrev(buffer.slice(start, j + 1))) {
      i = afterIdx;
      continue;
    }

    // Don't split when the sentence visibly continues — next non-space char is
    // lowercase or a digit ("Art. 5", "... 3. Januar"). A capital or quote means
    // a new sentence.
    const restAfter = buffer.slice(afterIdx);
    const vis = /\S/.exec(restAfter);
    const nx = vis ? restAfter[vis.index] : undefined;
    if (nx !== undefined && /[a-zäöüß0-9]/.test(nx)) {
      i = afterIdx;
      continue;
    }

    i = emit(afterIdx);
  }

  return { sentences, rest: buffer.slice(start) };
}
