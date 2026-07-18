import { db } from '@/lib/db';
import { encodeStrList, decodeStrList } from '@/lib/db-json';
import type { ToolAuditEntry } from './types';
import type { SeedSourceMessage } from './memory-seed';
import type { ConversationDigest } from './digest';
import { MemoryConfig } from './memory-config';

/**
 * Persistent conversation memory (Phase 2). Postgres-backed via
 * `AegisConversation` / `AegisMessage`, owned by the anonymous browser session
 * exactly like `AegisDocument`: every read is scoped
 * `where: { id, sessionId, expiresAt: { gt: now } }`, so a foreign or expired
 * conversation is indistinguishable from a nonexistent one.
 *
 * The full transcript is the authoritative record. Derived things (the resume
 * seed, in-flight compaction summaries) are computed at request time and never
 * written back — see docs/aegis/PHASE2_MEMORY_DESIGN.md §3.
 *
 * All write paths FAIL OPEN: a lost bookkeeping write must never kill a run
 * whose answer already streamed. Failures are loudly logged (structured
 * events), never silent.
 */

/** Conversations expire after this many days without a turn (from MemoryConfig). */
export const CONVERSATION_RETENTION_DAYS = MemoryConfig.conversationRetentionDays;
const RETENTION_MS = CONVERSATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const TITLE_MAX_CHARS = 80;
/** Per-tool-result cap inside the audit sidecar, to bound row size. */
const AUDIT_RESULT_MAX_CHARS = 20_000;

export type ConversationSummary = {
  id: string;
  mode: string;
  language: string;
  title: string | null;
  createdAt: Date;
  lastTurnAt: Date;
};

export type MemoryMessage = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  citedIds: string[];
  status: 'complete' | 'failed';
  exitReason: string | null;
  model: string | null;
  mode: string | null;
  toolCalls: unknown;
  createdAt: Date;
};

export type NewMessage = {
  role: 'user' | 'assistant';
  content: string;
  citedIds?: string[];
  status?: 'complete' | 'failed';
  exitReason?: string;
  model?: string;
  mode?: string;
  toolCalls?: ToolAuditEntry[];
  traceId?: string;
};

export type { ToolAuditEntry };

function reportMemoryFailure(op: string, err: unknown): void {
  console.error(
    JSON.stringify({
      event: 'aegis_memory_write_failed',
      level: 'error',
      op,
      detail: err instanceof Error ? err.message : String(err),
    }),
  );
}

function retentionHorizon(now: number): Date {
  return new Date(now + RETENTION_MS);
}

/** Deterministic conversation title: first user message, truncated. */
export function deriveTitle(firstUserMessage: string): string {
  const collapsed = firstUserMessage.replace(/\s+/g, ' ').trim();
  return collapsed.length <= TITLE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

/** Bound each audit entry so a huge tool result can't bloat the row. */
export function capToolAudit(entries: ToolAuditEntry[]): ToolAuditEntry[] {
  return entries.map((e) => ({
    ...e,
    result:
      e.result.length > AUDIT_RESULT_MAX_CHARS
        ? `${e.result.slice(0, AUDIT_RESULT_MAX_CHARS)}…[gekürzt]`
        : e.result,
  }));
}

// ───────────────────────── Conversations ─────────────────────────

/**
 * Create a conversation owned by `sessionId`. Returns its id, or null on DB
 * failure (fail-open: the run proceeds stateless for this turn).
 */
export async function createConversation(args: {
  sessionId: string;
  /** Owning user, when signed in — lets history be scoped to the account. */
  userId?: string | null;
  mode: string;
  language: string;
  firstUserMessage: string;
}): Promise<string | null> {
  const now = Date.now();
  try {
    const row = await db.aegisConversation.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId ?? null,
        mode: args.mode,
        language: args.language,
        title: deriveTitle(args.firstUserMessage),
        lastTurnAt: new Date(now),
        expiresAt: retentionHorizon(now),
      },
    });
    return row.id;
  } catch (err) {
    reportMemoryFailure('createConversation', err);
    return null;
  }
}

// ───────────────────────── Compaction digest (Phase 2) ─────────────────────────

export interface StoredDigest {
  digest: ConversationDigest;
  throughSeq: number;
}

/** Read the stored digest (unscoped — callers resolve ownership first). */
export async function getDigest(conversationId: string): Promise<StoredDigest | null> {
  const row = await db.aegisConversation.findUnique({
    where: { id: conversationId },
    select: { digest: true, digestThroughSeq: true },
  });
  if (!row?.digest || row.digestThroughSeq == null) return null;
  return {
    digest: row.digest as unknown as ConversationDigest,
    throughSeq: row.digestThroughSeq,
  };
}

/**
 * Persist a digest, scoped to the caller (user OR session) so a request can
 * only compact its own conversation. Returns true if a row was updated.
 */
export async function storeDigest(args: {
  id: string;
  sessionId: string | null;
  userId: string | null;
  digest: ConversationDigest;
  throughSeq: number;
}): Promise<boolean> {
  const owners = [
    ...(args.userId ? [{ userId: args.userId }] : []),
    ...(args.sessionId ? [{ sessionId: args.sessionId }] : []),
  ];
  if (owners.length === 0) return false;
  const res = await db.aegisConversation.updateMany({
    where: { id: args.id, OR: owners },
    data: {
      digest: args.digest as unknown as object,
      digestThroughSeq: args.throughSeq,
      digestAt: new Date(),
    },
  });
  return res.count > 0;
}

/** Ownership-scoped, expiry-aware single-conversation lookup. */
export async function getConversation(
  id: string,
  sessionId: string | null,
): Promise<ConversationSummary | null> {
  if (!sessionId) return null;
  const row = await db.aegisConversation.findFirst({
    where: { id, sessionId, expiresAt: { gt: new Date() } },
  });
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    language: row.language,
    title: row.title,
    createdAt: row.createdAt,
    lastTurnAt: row.lastTurnAt,
  };
}

export async function listConversations(
  sessionId: string,
): Promise<ConversationSummary[]> {
  const rows = await db.aegisConversation.findMany({
    where: { sessionId, expiresAt: { gt: new Date() } },
    orderBy: { lastTurnAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    language: row.language,
    title: row.title,
    createdAt: row.createdAt,
    lastTurnAt: row.lastTurnAt,
  }));
}

// ─────────── User-scoped variants (signed-in history across sessions) ───────────

function toSummary(row: {
  id: string;
  mode: string;
  language: string;
  title: string | null;
  createdAt: Date;
  lastTurnAt: Date;
}): ConversationSummary {
  return {
    id: row.id,
    mode: row.mode,
    language: row.language,
    title: row.title,
    createdAt: row.createdAt,
    lastTurnAt: row.lastTurnAt,
  };
}

/**
 * Adopt the current browser session's still-anonymous conversations into the
 * user account. Lets chats started before login (in this same browser) show up
 * in the signed-in history, and is a no-op once they're already owned. Scoped
 * to the caller's own session id, so it can only claim that browser's rows.
 * Returns the number newly claimed.
 */
export async function claimSessionConversations(
  sessionId: string,
  userId: string,
): Promise<number> {
  try {
    const res = await db.aegisConversation.updateMany({
      where: { sessionId, userId: null },
      data: { userId },
    });
    return res.count;
  } catch (err) {
    reportMemoryFailure('claimSessionConversations', err);
    return 0;
  }
}

/** Every conversation owned by the user (across sessions), newest first. */
export async function listConversationsForUser(
  userId: string,
): Promise<ConversationSummary[]> {
  const rows = await db.aegisConversation.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { lastTurnAt: 'desc' },
  });
  return rows.map(toSummary);
}

/** User-scoped single-conversation lookup. */
export async function getConversationForUser(
  id: string,
  userId: string | null,
): Promise<ConversationSummary | null> {
  if (!userId) return null;
  const row = await db.aegisConversation.findFirst({
    where: { id, userId, expiresAt: { gt: new Date() } },
  });
  return row ? toSummary(row) : null;
}

/** User-scoped full transcript. */
export async function getTranscriptForUser(
  id: string,
  userId: string | null,
): Promise<{ conversation: ConversationSummary; messages: MemoryMessage[] } | null> {
  const conversation = await getConversationForUser(id, userId);
  if (!conversation) return null;
  return { conversation, messages: await messagesOf(id) };
}

/** Hard-delete one of the user's conversations (cascades to messages). */
export async function deleteConversationForUser(
  id: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  const res = await db.aegisConversation.deleteMany({ where: { id, userId } });
  if (res.count > 0) await handleUsageRowsOnErasure([id]);
  return res.count > 0;
}

/** Hard-delete every conversation owned by the user. Returns the count. */
export async function deleteAllConversationsForUser(userId: string): Promise<number> {
  const ids = await db.aegisConversation.findMany({
    where: { userId },
    select: { id: true },
  });
  const res = await db.aegisConversation.deleteMany({ where: { userId } });
  if (res.count > 0) await handleUsageRowsOnErasure(ids.map((r) => r.id));
  return res.count;
}

export async function getTranscript(
  id: string,
  sessionId: string | null,
): Promise<{ conversation: ConversationSummary; messages: MemoryMessage[] } | null> {
  const conversation = await getConversation(id, sessionId);
  if (!conversation) return null;
  return { conversation, messages: await messagesOf(id) };
}

/** Ordered messages for a conversation (caller must have checked ownership). */
async function messagesOf(conversationId: string): Promise<MemoryMessage[]> {
  const rows = await db.aegisMessage.findMany({
    where: { conversationId },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    role: r.role as MemoryMessage['role'],
    content: r.content,
    citedIds: decodeStrList(r.citedIds),
    status: r.status as MemoryMessage['status'],
    exitReason: r.exitReason,
    model: r.model,
    mode: r.mode,
    toolCalls: r.toolCalls,
    createdAt: r.createdAt,
  }));
}

/**
 * Lean transcript projection for the resume-seed builder — no sidecars, no
 * ownership check (callers must have resolved the conversation through
 * `getConversation` first).
 */
export async function getSeedRows(
  conversationId: string,
): Promise<SeedSourceMessage[]> {
  const rows = await db.aegisMessage.findMany({
    where: { conversationId },
    orderBy: { seq: 'asc' },
    select: { seq: true, role: true, content: true, status: true },
  });
  return rows.map((r) => ({
    seq: r.seq,
    role: r.role as SeedSourceMessage['role'],
    content: r.content,
    status: r.status as SeedSourceMessage['status'],
  }));
}

// ───────────────────────── Messages ─────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

/**
 * Append a message with a transactionally assigned dense `seq`:
 * SELECT max(seq)+1 and INSERT inside one short transaction; on a concurrent
 * writer racing us to the same seq (@@unique violation, P2002) retry ONCE,
 * then fail open. Never silent: both the retry and the final failure are
 * observable (the failure via `aegis_memory_write_failed`).
 *
 * Returns the assigned seq, or null when the write was lost (callers surface
 * this as `persisted: false`).
 */
export async function appendMessage(
  conversationId: string,
  msg: NewMessage,
): Promise<number | null> {
  const insertOnce = async (): Promise<number> =>
    db.$transaction(async (tx) => {
      const last = await tx.aegisMessage.findFirst({
        where: { conversationId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (last?.seq ?? -1) + 1;
      await tx.aegisMessage.create({
        data: {
          conversationId,
          seq,
          role: msg.role,
          content: msg.content,
          citedIds: encodeStrList(msg.citedIds),
          status: msg.status ?? 'complete',
          exitReason: msg.exitReason,
          model: msg.model,
          mode: msg.mode,
          toolCalls: msg.toolCalls
            ? (capToolAudit(msg.toolCalls) as unknown as object)
            : undefined,
          traceId: msg.traceId,
        },
      });
      return seq;
    });

  let seq: number;
  try {
    seq = await insertOnce();
  } catch (err) {
    if (!isUniqueViolation(err)) {
      reportMemoryFailure('appendMessage', err);
      return null;
    }
    try {
      seq = await insertOnce();
    } catch (retryErr) {
      reportMemoryFailure('appendMessage(retry)', retryErr);
      return null;
    }
  }

  // Refresh activity + retention horizon; opportunistic sweep piggybacks.
  const now = Date.now();
  void db.aegisConversation
    .update({
      where: { id: conversationId },
      data: { lastTurnAt: new Date(now), expiresAt: retentionHorizon(now) },
    })
    .catch((err) => reportMemoryFailure('refreshRetention', err));
  void sweepExpiredConversations().catch(() => {});

  return seq;
}

// ───────────────────────── Erasure & retention ─────────────────────────

/**
 * What happens to `AegisUsageLog` rows when a conversation is erased.
 *
 * DECISION (signed off, see design §4): they are KEPT — they contain no
 * message content (token counts, costs, mode, flags only) and their
 * `conversationId` becomes a dangling pseudonym once the conversation is
 * gone. Isolated here as one named step so a future per-tenant scrub (null
 * or hash the ids) is a one-function change.
 */
async function handleUsageRowsOnErasure(_conversationIds: string[]): Promise<void> {
  // Intentional no-op: content-free usage rows are retained for billing/audit.
}

/** Hard-delete one conversation (cascade deletes its messages). */
export async function deleteConversation(
  id: string,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) return false;
  const res = await db.aegisConversation.deleteMany({ where: { id, sessionId } });
  if (res.count > 0) await handleUsageRowsOnErasure([id]);
  return res.count > 0;
}

/** Hard-delete every conversation owned by the session. Returns the count. */
export async function deleteAllConversations(sessionId: string): Promise<number> {
  const ids = await db.aegisConversation.findMany({
    where: { sessionId },
    select: { id: true },
  });
  const res = await db.aegisConversation.deleteMany({ where: { sessionId } });
  if (res.count > 0) await handleUsageRowsOnErasure(ids.map((r) => r.id));
  return res.count;
}

/**
 * Session-agnostic retention sweep: hard-delete every conversation past its
 * `expiresAt`. The guarantee is the daily cron (app/api/cron/retention);
 * the on-write call in `appendMessage` is just an optimization.
 */
export async function sweepExpiredConversations(): Promise<number> {
  const res = await db.aegisConversation.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
