import { z } from 'zod';
import { db } from '@/lib/db';

/**
 * Shape of one persisted AEGIS usage row. Validated with Zod before it touches
 * the DB so a malformed record (e.g. a NaN cost from a future refactor) is
 * rejected loudly in the log rather than silently corrupting the dashboard.
 */
export const AegisUsageRecordSchema = z.object({
  traceId: z.string(),
  conversationId: z.string(),
  mode: z.string(),
  model: z.string(),
  /** Served model(s) — `response.model`, distinct set joined; null if unknown. */
  servedModel: z.string().nullable(),
  language: z.string(),
  // Token buckets — stored raw so a future rate change can be recomputed from
  // tokens rather than lost to a baked-in dollar figure.
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Prompt-cache READ tokens. */
  cachedTokens: z.number().int().nonnegative(),
  /** Prompt-cache WRITE (creation) tokens, both TTLs combined. */
  cacheCreationTokens: z.number().int().nonnegative(),
  /** Cost in USD cents (e.g. 0.42 = 0.42¢). */
  costCents: z.number().nonnegative(),
  /** Rate table version used to compute `costCents`. */
  pricingVersion: z.string(),
  /** How the run terminated: "done", an AegisError code, or "aborted". */
  exitReason: z.string(),
  latencyMs: z.number().int().nonnegative(),
  iterations: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  verifyPassed: z.boolean(),
  citationCount: z.number().int().nonnegative(),
  guardrailsTriggered: z.array(z.string()),
  kbVersion: z.string(),
});

export type AegisUsageRecord = z.infer<typeof AegisUsageRecordSchema>;

/**
 * Emit a structured, queryable error for a usage-logging failure.
 *
 * This repo has no pino/winston/Sentry, so we match the existing structured-
 * `console` convention (see lib/aegis/client.ts `claude_call`). The stable
 * `event` value is the hook for a log-based counter/alert — wire an alert on
 * `aegis_usage_log_failed` so a forgotten `prisma db push` (which silently
 * reverts the dashboard to logging $0) surfaces instead of hiding.
 *
 * `record` is typed loosely because the Zod-reject path may receive a value
 * that failed validation; we still want whatever `model`/`exitReason` it has.
 */
function reportUsageLogFailure(
  event: 'aegis_usage_log_failed' | 'aegis_usage_log_rejected',
  record: Partial<AegisUsageRecord> | unknown,
  detail: string,
): void {
  const r = (record ?? {}) as Partial<AegisUsageRecord>;
  console.error(
    JSON.stringify({
      event,
      level: 'error',
      model: typeof r.model === 'string' ? r.model : 'unknown',
      exitReason: typeof r.exitReason === 'string' ? r.exitReason : 'unknown',
      detail,
    }),
  );
}

/**
 * Persist one AEGIS usage record. Fail-safe by design: a DB outage or a
 * malformed record must never break the user-visible AEGIS response. Callers
 * fire-and-forget. Failures are swallowed but reported via
 * `reportUsageLogFailure` so they are observable, not silent.
 */
export async function logUsage(record: AegisUsageRecord): Promise<void> {
  const parsed = AegisUsageRecordSchema.safeParse(record);
  if (!parsed.success) {
    reportUsageLogFailure(
      'aegis_usage_log_rejected',
      record,
      JSON.stringify(parsed.error.issues),
    );
    return;
  }
  try {
    await db.aegisUsageLog.create({ data: parsed.data });
  } catch (err) {
    reportUsageLogFailure(
      'aegis_usage_log_failed',
      parsed.data,
      err instanceof Error ? err.message : String(err),
    );
  }
}
