/**
 * Shared passage extraction + token scoring, used by both `read_source` (raw
 * legislation files on disk) and `search_ingested_documents` (radar-ingested
 * documents in Postgres). Keeping one ranking implementation avoids drift
 * between the two raw-source search paths.
 */

export const MAX_PASSAGE_CHARS = 2000; // ≈ 500 tokens at ~4 chars/token
export const MIN_PASSAGE_CHARS = 50;

const WORD_CHAR_CLASS = 'a-z0-9äöüß';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\wäöüß-]+|[^\wäöüß-]+$/g, ''))
    .filter((t) => t.length > 1 || /^\d+$/.test(t));
}

export function countTokenHits(passage: string, token: string): number {
  const re = new RegExp(
    `(?:^|[^${WORD_CHAR_CLASS}])${escapeRegex(token)}(?=$|[^${WORD_CHAR_CLASS}])`,
    'g',
  );
  let count = 0;
  while (re.exec(passage) !== null) count++;
  return count;
}

/**
 * Split text into passages on paragraph breaks. Accepts both \n\n and
 * \r\n\r\n separators, drops sub-threshold fragments, truncates overlong ones.
 */
export function splitIntoPassages(text: string): string[] {
  return text
    .split(/(?:\r?\n){2,}/)
    .map((p) => p.replace(/\r/g, '').trim())
    .filter((p) => p.length >= MIN_PASSAGE_CHARS)
    .map((p) => (p.length > MAX_PASSAGE_CHARS ? p.slice(0, MAX_PASSAGE_CHARS) + '…' : p));
}

export type RankedPassage = { passage: string; score: number };

/** Rank a document's passages by token-hit frequency; returns the top `cap`. */
export function rankPassages(text: string, query: string, cap: number): RankedPassage[] {
  const passages = splitIntoPassages(text);
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: RankedPassage[] = [];
  for (const passage of passages) {
    const lower = passage.toLowerCase();
    let score = 0;
    for (const tok of tokens) score += countTokenHits(lower, tok);
    if (score > 0) scored.push({ passage, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(cap, 1));
}
