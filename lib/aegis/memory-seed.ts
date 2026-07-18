/**
 * Resume-seed construction (pure — no I/O, fully unit-testable).
 *
 * The seed replayed into the model is built from COMPLETE user/assistant
 * pairs only (amendment 3): a user message whose run failed or never produced
 * a complete assistant turn stays in Postgres for UI/audit but never enters
 * the prompt. Pair extraction (not status filtering) guarantees the strict
 * user/assistant alternation the API requires — the same invariant
 * `trimForRetry` maintains by rebuilding from the text-only seed.
 *
 * Budgeting uses a character-based token estimate: German compounds tokenize
 * denser than English, so `de` content uses chars/3.5 instead of chars/4
 * (amendment 5). The budget is SOFT — pre-flight compaction in the run is the
 * safety net, selection here just keeps the load sane.
 */

export type SeedSourceMessage = {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'failed';
};

export type SeedMessage = {
  role: 'user' | 'assistant';
  content: string;
};

import { MemoryConfig, estimateTokensFromChars } from './memory-config';

export function estimateTokens(text: string, language: 'de' | 'en'): number {
  return estimateTokensFromChars(text.length, language);
}

type Pair = { user: SeedSourceMessage; assistant: SeedSourceMessage };

/**
 * Extract complete (user, assistant[status=complete]) pairs in transcript
 * order. Walking rules:
 *   - a user row becomes the pending half of a pair (a newer user row
 *     supersedes an older orphan),
 *   - a complete assistant row closes the pending pair,
 *   - a failed assistant row discards the pending user (that turn failed),
 *   - assistant rows with no pending user are skipped (defensive).
 */
export function extractCompletePairs(messages: SeedSourceMessage[]): Pair[] {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const pairs: Pair[] = [];
  let pendingUser: SeedSourceMessage | null = null;

  for (const m of ordered) {
    if (m.role === 'user') {
      pendingUser = m;
      continue;
    }
    // assistant
    if (!pendingUser) continue;
    if (m.status === 'complete') {
      pairs.push({ user: pendingUser, assistant: m });
    }
    pendingUser = null;
  }
  return pairs;
}

/**
 * Build the replay seed: newest complete pairs first under the token budget
 * (whole pairs only — never half a pair), then re-ordered oldest→newest.
 * Output always strictly alternates user/assistant and starts with a user
 * turn, so appending the new user message keeps the API-valid shape.
 */
export function buildSeed(
  messages: SeedSourceMessage[],
  language: 'de' | 'en',
  budgetTokens: number,
): SeedMessage[] {
  const pairs = extractCompletePairs(messages);

  const selected: Pair[] = [];
  let spent = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const pair = pairs[i];
    const cost =
      estimateTokens(pair.user.content, language) +
      estimateTokens(pair.assistant.content, language);
    // Always keep at least `minimumConversationPairs` newest pairs, even over
    // budget (a single huge pair must not erase all recent context); beyond that,
    // stop before exceeding the soft budget.
    if (selected.length >= MemoryConfig.minimumConversationPairs && spent + cost > budgetTokens) {
      break;
    }
    selected.push(pair);
    spent += cost;
  }
  selected.reverse();

  const seed: SeedMessage[] = [];
  for (const pair of selected) {
    seed.push({ role: 'user', content: pair.user.content });
    seed.push({ role: 'assistant', content: pair.assistant.content });
  }
  return seed;
}

/** Estimated token total of an assembled seed (for the pre-flight compaction check). */
export function estimateSeedTokens(
  seed: SeedMessage[],
  language: 'de' | 'en',
): number {
  return seed.reduce((sum, m) => sum + estimateTokens(m.content, language), 0);
}
