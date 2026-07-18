/**
 * Centralized memory & context-window configuration — the SINGLE source of
 * truth for every conversation-memory limit in AEGIS.
 *
 * Long-term memory (the full transcript in Postgres) is distinct from working
 * memory (what the model actually receives). These limits govern working
 * memory: how much conversation is replayed, when it is compacted, how large a
 * structured digest may be, and how long long-term memory is retained.
 *
 * No memory-related magic numbers may live anywhere else — every consumer
 * (guardrails, seed assembly, compaction, digest, context health, retention)
 * reads from here. Values are environment-overridable for per-deployment tuning;
 * the defaults are production-grade for long-running regulatory projects (DORA,
 * EU AI Act, NIS2, CRA, ISO 42001, …) spanning many hours and hundreds of pages.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MemoryConfig = {
  /**
   * Working-memory budget for the replayed conversation seed (estimated tokens).
   * The newest complete Q/A pairs are loaded up to this budget. Sits below
   * `autoCompactionTokens` to leave headroom for the system prompt + tool output
   * before compaction triggers.
   */
  seedBudgetTokens: intEnv('AEGIS_SEED_BUDGET_TOKENS', 100_000),

  /**
   * Automatic compaction trigger: when the live context for a turn exceeds this
   * many tokens, the middle of the history is summarized (see compress.ts).
   */
  autoCompactionTokens: intEnv('AEGIS_AUTO_COMPACTION_TOKENS', 150_000),

  /**
   * Largest transcript (estimated tokens) a single structured digest will
   * compact in one pass. Above this the digest refuses rather than silently
   * truncating.
   */
  digestMaxInputTokens: intEnv('AEGIS_DIGEST_MAX_INPUT_TOKENS', 500_000),

  /**
   * Always keep at least this many complete Q/A pairs in working memory, even if
   * the budget is exceeded (a single huge pair must not erase all recent context).
   */
  minimumConversationPairs: intEnv('AEGIS_MIN_CONVERSATION_PAIRS', 1),

  /** Long-term retention of the Postgres transcript (days). */
  conversationRetentionDays: intEnv('AEGIS_CONVERSATION_RETENTION_DAYS', 30),

  /**
   * Compaction anchors: keep the first N and the last N messages verbatim; only
   * the middle is summarized.
   */
  compactionKeepFirst: intEnv('AEGIS_COMPACTION_KEEP_FIRST', 2),
  compactionKeepLast: intEnv('AEGIS_COMPACTION_KEEP_LAST', 4),

  /**
   * Char→token estimate divisors. German compounds tokenize denser than English,
   * so German content is estimated with a smaller divisor (more tokens/char).
   */
  charsPerTokenDe: numEnv('AEGIS_CHARS_PER_TOKEN_DE', 3.5),
  charsPerTokenEn: numEnv('AEGIS_CHARS_PER_TOKEN_EN', 4),

  /** Max chars of transcript fed into soul-observation proposal generation. */
  soulTranscriptMaxChars: intEnv('AEGIS_SOUL_TRANSCRIPT_MAX_CHARS', 40_000),
} as const;

export type MemoryConfigShape = typeof MemoryConfig;

/** Estimate tokens from character length for a given language (centralized). */
export function estimateTokensFromChars(charCount: number, language: 'de' | 'en'): number {
  const divisor = language === 'de' ? MemoryConfig.charsPerTokenDe : MemoryConfig.charsPerTokenEn;
  return Math.ceil(charCount / divisor);
}
