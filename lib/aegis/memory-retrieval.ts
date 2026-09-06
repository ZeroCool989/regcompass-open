/**
 * Retrieval seam for AEGIS working memory.
 *
 * Separates WHAT context is selected from HOW it is loaded, so a future
 * semantic/embedding retriever can replace the current chronological loading
 * WITHOUT touching the callers.
 *
 * Long-term memory  = the full transcript persisted in Postgres (memory.ts).
 * Working memory     = the bounded subset assembled into the model context here.
 * The model only ever receives working memory.
 */

import { buildSeed, type SeedMessage, type SeedSourceMessage } from './memory-seed';
import { MemoryConfig } from './memory-config';

// ───────────────────────── Conversation retrieval ─────────────────────────

export type RetrieveConversationInput = {
  /** Long-term transcript rows (lean projection from Postgres). */
  messages: SeedSourceMessage[];
  language: 'de' | 'en';
  /** Working-memory token budget; defaults to the centralized seed budget. */
  budgetTokens?: number;
  /** Optional current request — a semantic retriever can rank relevance to it. */
  query?: string;
};

/**
 * Selects the conversation turns relevant to the current request, within a token
 * budget, returned as API-ready alternating user/assistant pairs.
 *
 * Default impl: chronological (most-recent complete pairs). A future
 * `SemanticConversationRetriever` can implement the same contract using `query`.
 */
export interface ConversationRetriever {
  retrieve(input: RetrieveConversationInput): SeedMessage[];
}

/** Recent complete pairs under the seed budget — the current behavior. */
export class ChronologicalConversationRetriever implements ConversationRetriever {
  retrieve(input: RetrieveConversationInput): SeedMessage[] {
    const budget = input.budgetTokens ?? MemoryConfig.seedBudgetTokens;
    return buildSeed(input.messages, input.language, budget);
  }
}

/** The default retriever instance used across the app today. */
export const defaultConversationRetriever: ConversationRetriever =
  new ChronologicalConversationRetriever();

export type { SeedMessage };
