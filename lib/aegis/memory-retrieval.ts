/**
 * Retrieval & assembly seams for AEGIS working memory.
 *
 * These interfaces separate WHAT context is selected from HOW it is loaded, so a
 * future semantic/embedding retriever can replace the current chronological and
 * full-document loading WITHOUT touching the callers. The current default
 * implementations are intentionally chronological / whole-document — the seam is
 * the deliverable, not embeddings.
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

// ───────────────────────── Document retrieval ─────────────────────────

export type DocumentChunk = {
  documentId: string;
  text: string;
  /** Chunk position within the document. */
  index: number;
  /** Relevance score (semantic retriever); undefined for whole-document loads. */
  score?: number;
};

export type RetrieveDocumentInput = {
  documentId: string;
  text: string;
  /** Query to rank chunks against (future semantic retrieval). */
  query?: string;
  /** Max chunks to return; undefined = no cap (whole document). */
  maxChunks?: number;
};

/**
 * Selects the document content relevant to a query. Default impl returns the
 * whole document as a single chunk (current full-injection behavior). A future
 * `SemanticDocumentRetriever` returns only the top-k relevant chunks so very
 * large uploads no longer flood the context.
 */
export interface DocumentRetriever {
  retrieve(input: RetrieveDocumentInput): DocumentChunk[];
}

/** Whole-document single chunk — a seam for future chunked/semantic retrieval. */
export class FullDocumentRetriever implements DocumentRetriever {
  retrieve(input: RetrieveDocumentInput): DocumentChunk[] {
    return [{ documentId: input.documentId, text: input.text, index: 0 }];
  }
}

export const defaultDocumentRetriever: DocumentRetriever = new FullDocumentRetriever();

// ───────────────────────── Context assembly ─────────────────────────

export type SystemBlock = { text: string; cached: boolean };

export type AssembleContextInput = {
  /** [1] System prompt blocks (identity + mode), cacheable. */
  systemBlocks: SystemBlock[];
  /** [2] Soul / personalization block (uncached trailing), if any. */
  soulBlock?: SystemBlock | null;
  /** [3] The current user request. */
  userRequest: string;
  /** [4]+[5] Recent + relevant prior conversation (already retrieved, ordered oldest→newest). */
  conversation: SeedMessage[];
  /** [6] Retrieved document chunks to inline (default: none — docs go via tools). */
  documentChunks?: DocumentChunk[];
};

export type AssembledContext = {
  systemBlocks: SystemBlock[];
  messages: SeedMessage[];
};

/**
 * Assembles working memory in the documented priority order:
 *   1. System prompt → 2. Soul → 3. Current user request →
 *   4. Recent conversation → 5. Relevant previous conversation →
 *   6. Retrieved document chunks.
 *
 * Returns API-ready system blocks + an alternating message list. It never
 * blindly includes the whole conversation — only what the retriever selected.
 */
export interface ContextBuilder {
  build(input: AssembleContextInput): AssembledContext;
}

export class PriorityContextBuilder implements ContextBuilder {
  build(input: AssembleContextInput): AssembledContext {
    // [1] system + [2] soul (soul is appended last & uncached so it never breaks
    // the cached system prefix, and is explicitly subordinate to grounding).
    const systemBlocks: SystemBlock[] = [
      ...input.systemBlocks,
      ...(input.soulBlock ? [input.soulBlock] : []),
    ];

    // [4]+[5] retrieved conversation (oldest→newest), then [6] doc chunks as a
    // synthetic user turn, then [3] the current user request last.
    const messages: SeedMessage[] = [...input.conversation];

    if (input.documentChunks && input.documentChunks.length > 0) {
      const docText = input.documentChunks
        .map((c) => c.text)
        .join('\n\n')
        .trim();
      if (docText) {
        messages.push({ role: 'user', content: `<<RETRIEVED DOCUMENT CONTEXT>>\n${docText}` });
        messages.push({ role: 'assistant', content: 'Verstanden.' });
      }
    }

    messages.push({ role: 'user', content: input.userRequest });
    return { systemBlocks, messages };
  }
}

export const defaultContextBuilder: ContextBuilder = new PriorityContextBuilder();
