import { db } from '@/lib/db';
import type { AegisPlan, PlanSection, PlanVocab } from './plan';
import {
  assertJobTransition,
  assertSectionTransition,
  jobExpiresAt,
  jobMaxResumes,
  InvalidTransitionError,
  type JobStatus,
  type SectionStatus,
} from './statechart';

/**
 * Persistence layer for sectioned jobs (epic Station 2). All writes are
 * status-guarded (`updateMany` scoped on the CURRENT status) so a concurrent
 * transition — two resumes racing, executor vs. retention cron — loses cleanly
 * with `InvalidTransitionError` instead of overwriting a terminal state.
 *
 * Ownership (F2): a job is reachable ONLY through the join to its
 * `AegisConversation` (sessionId OR userId). Foreign/unknown ids yield `null`
 * and the caller answers 404 — no existence oracle.
 *
 * The Prisma client is injectable for tests; production callers use the
 * default `db` (retry-wrapped for Neon cold starts).
 */

/** Subset of PrismaClient the store uses — lets tests pass an in-memory stub. */
export type JobDb = {
  aegisJob: {
    create: (args: unknown) => Promise<JobRow>;
    findFirst: (args: unknown) => Promise<JobRow | null>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  aegisJobSection: {
    createMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<SectionRow[]>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  aegisConversation: {
    findFirst: (
      args: unknown,
    ) => Promise<{ id: string; mode?: string; language?: string } | null>;
  };
  aegisMessage: {
    findFirst: (args: unknown) => Promise<{ content: string } | null>;
  };
  $transaction: <T>(fn: (tx: JobDb) => Promise<T>) => Promise<T>;
};

export type JobRow = {
  id: string;
  conversationId: string;
  status: string;
  /** The frozen runtime provider (three-card value). Null only for pre-migration
   *  legacy rows; resume fails closed on null. */
  provider: string | null;
  planJson: unknown;
  vocabJson: unknown;
  cursor: number;
  resumeCount: number;
  expiresAt: Date;
};

export type SectionRow = {
  id: string;
  jobId: string;
  index: number;
  title: string;
  scopeJson: unknown;
  status: string;
  contentMd: string | null;
  digestJson: unknown;
  citationsJson: unknown;
  verifyJson: unknown;
  firstPassOk: boolean | null;
};

const defaultDb = (): JobDb => db as unknown as JobDb;

// ───────────────────────── Create ─────────────────────────

export async function createJob(
  conversationId: string,
  plan: AegisPlan,
  /** The frozen runtime provider (three-card value), persisted so resume runs on
   *  the SAME brain. New jobs always set it — never null in application code. */
  provider: string,
  client: JobDb = defaultDb(),
): Promise<JobRow> {
  return client.$transaction(async (tx) => {
    const job = await tx.aegisJob.create({
      data: {
        conversationId,
        status: 'planning' satisfies JobStatus,
        provider,
        planJson: plan.sections as unknown,
        vocabJson: plan.vocab as unknown,
        cursor: 0,
        resumeCount: 0,
        expiresAt: jobExpiresAt(),
      },
    });
    await tx.aegisJobSection.createMany({
      data: plan.sections.map((section, index) => ({
        jobId: job.id,
        index,
        title: section.title,
        scopeJson: section as unknown,
        status: 'pending' satisfies SectionStatus,
      })),
    });
    return job;
  });
}

// ───────────────────────── Load (ownership-scoped, F2) ─────────────────────────

export type JobWithSections = {
  job: JobRow;
  sections: SectionRow[];
  conversation: { mode: string; language: 'de' | 'en' };
};

/**
 * Load a job iff it belongs to a conversation owned by this session or user.
 * Unknown id, foreign owner, or expired job → `null` (caller answers 404).
 */
export async function loadJobForOwner(
  jobId: string,
  owner: { sessionId: string | null; userId: string | null },
  client: JobDb = defaultDb(),
): Promise<JobWithSections | null> {
  if (!owner.sessionId && !owner.userId) return null;
  const job = await client.aegisJob.findFirst({ where: { id: jobId } });
  if (!job) return null;
  if (job.expiresAt.getTime() <= Date.now()) return null;

  const ownershipOr: Array<Record<string, string>> = [];
  if (owner.sessionId) ownershipOr.push({ sessionId: owner.sessionId });
  if (owner.userId) ownershipOr.push({ userId: owner.userId });
  const conversation = await client.aegisConversation.findFirst({
    where: { id: job.conversationId, OR: ownershipOr },
    select: { id: true, mode: true, language: true },
  });
  if (!conversation) return null;

  const sections = await client.aegisJobSection.findMany({
    where: { jobId },
    orderBy: { index: 'asc' },
  });
  return {
    job,
    sections,
    conversation: {
      mode: conversation.mode ?? 'CONVERSATIONAL',
      language: conversation.language === 'en' ? 'en' : 'de',
    },
  };
}

/** First user turn of the conversation — the deliverable ask a resume re-uses. */
export async function firstUserMessage(
  conversationId: string,
  client: JobDb = defaultDb(),
): Promise<string | null> {
  const row = await client.aegisMessage.findFirst({
    where: { conversationId, role: 'user' },
    orderBy: { seq: 'asc' },
    select: { content: true },
  });
  return row?.content ?? null;
}

// ───────────────────────── Guarded transitions ─────────────────────────

/**
 * Transition the job status. Validates against the statechart FIRST (throws on
 * a statically-invalid pair), then performs a status-scoped write so a lost
 * race also surfaces as `InvalidTransitionError`.
 */
export async function transitionJob(
  jobId: string,
  from: JobStatus,
  to: JobStatus,
  client: JobDb = defaultDb(),
): Promise<void> {
  assertJobTransition(from, to);
  const { count } = await client.aegisJob.updateMany({
    where: { id: jobId, status: from },
    data: { status: to },
  });
  if (count !== 1) throw new InvalidTransitionError('job', `${from} (stale)`, to);
}

export async function transitionSection(
  jobId: string,
  index: number,
  from: SectionStatus,
  to: SectionStatus,
  client: JobDb = defaultDb(),
): Promise<void> {
  assertSectionTransition(from, to);
  const { count } = await client.aegisJobSection.updateMany({
    where: { jobId, index, status: from },
    data: { status: to },
  });
  if (count !== 1) throw new InvalidTransitionError('section', `${from} (stale)`, to);
}

// ───────────────────────── Section results (P3: all-or-nothing) ─────────────────────────

export type SectionResult = {
  status: Extract<SectionStatus, 'done' | 'degraded'>;
  contentMd: string;
  digestJson: unknown;
  citationsJson: string[];
  verifyJson: unknown;
  firstPassOk: boolean;
};

/**
 * Persist a FINISHED section and advance the job cursor in one transaction.
 * Half-finished sections are never written (P3) — the executor only calls this
 * with a terminal section status, and a crash before this call leaves the
 * section 'writing', which `resetStaleWriting` returns to 'pending' on resume.
 */
export async function persistSectionResult(
  jobId: string,
  index: number,
  from: Extract<SectionStatus, 'writing' | 'revising'>,
  result: SectionResult,
  client: JobDb = defaultDb(),
): Promise<void> {
  assertSectionTransition(from, result.status);
  await client.$transaction(async (tx) => {
    const { count } = await tx.aegisJobSection.updateMany({
      where: { jobId, index, status: from },
      data: {
        status: result.status,
        contentMd: result.contentMd,
        digestJson: result.digestJson as never,
        citationsJson: result.citationsJson as never,
        verifyJson: result.verifyJson as never,
        firstPassOk: result.firstPassOk,
      },
    });
    if (count !== 1) {
      throw new InvalidTransitionError('section', `${from} (stale)`, result.status);
    }
    await tx.aegisJob.updateMany({
      where: { id: jobId },
      data: { cursor: index + 1 },
    });
  });
}

/**
 * On resume: any section left in 'writing'/'revising' by a killed invocation
 * is returned to 'pending' so it regenerates from scratch — partial output was
 * never persisted, so this cannot duplicate content (non-duplicating retry).
 */
export async function resetStaleWriting(
  jobId: string,
  client: JobDb = defaultDb(),
): Promise<number> {
  const { count } = await client.aegisJobSection.updateMany({
    where: { jobId, status: { in: ['writing', 'revising'] } },
    data: { status: 'pending' },
  });
  return count;
}

// ───────────────────────── Resume budget (F4) ─────────────────────────

export type ResumeBudget =
  | { ok: true; resumeCount: number }
  | { ok: false; reason: 'cap_exceeded' };

/**
 * Atomically consume one resume. The increment is guarded (`resumeCount <
 * cap`) so two racing resumes cannot both pass the cap; on exhaustion the job
 * fails closed and the caller writes the audit event.
 */
export async function consumeResume(
  jobId: string,
  currentStatus: JobStatus,
  client: JobDb = defaultDb(),
): Promise<ResumeBudget> {
  const cap = jobMaxResumes();
  const { count } = await client.aegisJob.updateMany({
    where: { id: jobId, resumeCount: { lt: cap } },
    data: { resumeCount: { increment: 1 } },
  });
  if (count === 1) {
    const job = await client.aegisJob.findFirst({ where: { id: jobId } });
    return { ok: true, resumeCount: job?.resumeCount ?? -1 };
  }
  // Cap exhausted → job fails closed (F4). Tolerate an already-terminal job.
  try {
    await transitionJob(jobId, currentStatus, 'failed', client);
  } catch {
    /* already terminal — nothing to fail */
  }
  return { ok: false, reason: 'cap_exceeded' };
}

// ───────────────────────── Typed accessors ─────────────────────────

export function planSections(job: JobRow): PlanSection[] {
  return job.planJson as PlanSection[];
}

export function planVocab(job: JobRow): PlanVocab {
  return job.vocabJson as PlanVocab;
}
