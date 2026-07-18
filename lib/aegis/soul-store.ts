/**
 * Soul persistence + governance (Neon is the canonical source of truth). All
 * ops are user-scoped. The AI path can only create SoulProposal rows; nothing
 * reaches SoulEntry without an explicit user decision that re-checks the
 * content firewall AND the governance gates (contradiction / duplicate).
 */

import { db } from '@/lib/db';
import {
  computeMaturity,
  firewallReason,
  renderSoulMarkdown,
  soulSystemBlock,
  type SoulProposalDraft,
} from './soul';
import {
  computeMemoryHealth,
  deriveStage,
  detectContradictions,
  DUPLICATE_THRESHOLD,
  findConflict,
  findDuplicates,
  similarity,
  type GovEntry,
} from './soul-health';

const ENTRY_SELECT = {
  id: true,
  section: true,
  content: true,
  signalCount: true,
  status: true,
  usedCount: true,
  lastConfirmedAt: true,
  createdAt: true,
} as const;

export async function listAllEntries(userId: string) {
  return db.soulEntry.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: ENTRY_SELECT,
  });
}

export async function listActiveEntries(userId: string) {
  return db.soulEntry.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: ENTRY_SELECT,
  });
}

export async function listPendingProposals(userId: string) {
  return db.soulProposal.findMany({
    where: { userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, section: true, content: true, reason: true, createdAt: true },
  });
}

/**
 * Build the style-only system block from ACTIVE entries only, and bump their
 * usedCount (fire-and-forget — a usefulness signal that must never block or
 * slow a chat turn). Returns null if there are no active entries.
 */
export async function buildUserSoulBlock(userId: string): Promise<string | null> {
  const entries = await listActiveEntries(userId);
  if (entries.length === 0) return null;
  void db.soulEntry
    .updateMany({ where: { id: { in: entries.map((e) => e.id) } }, data: { usedCount: { increment: 1 } } })
    .catch(() => {});
  return soulSystemBlock(entries);
}

/** Everything the memory dashboard needs in one read. */
export async function soulSnapshot(userId: string, username?: string | null) {
  const [all, proposals, audit] = await Promise.all([
    listAllEntries(userId),
    listPendingProposals(userId),
    db.soulAudit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { action: true, section: true, content: true, createdAt: true },
    }),
  ]);

  const gov: GovEntry[] = all.map((e) => ({
    id: e.id,
    section: e.section,
    content: e.content,
    signalCount: e.signalCount,
    status: e.status as GovEntry['status'],
    usedCount: e.usedCount,
    lastConfirmedAt: e.lastConfirmedAt.toISOString(),
  }));
  const active = gov.filter((e) => e.status === 'ACTIVE');

  const maturity = computeMaturity(active);
  const memoryHealth = computeMemoryHealth(active);
  const duplicates = findDuplicates(active);
  const contradictions = detectContradictions(active);

  const entries = all.map((e) => ({
    id: e.id,
    section: e.section,
    content: e.content,
    signalCount: e.signalCount,
    status: e.status as GovEntry['status'],
    usedCount: e.usedCount,
    lastConfirmedAt: e.lastConfirmedAt.toISOString(),
    stage: deriveStage({ status: e.status, lastConfirmedAt: e.lastConfirmedAt } as GovEntry),
  }));

  const markdown = renderSoulMarkdown(active, {
    username,
    maturity,
    updatedAt: all.at(-1)?.createdAt.toISOString().slice(0, 10),
  });

  return {
    entries,
    proposals,
    maturity,
    memoryHealth,
    duplicates,
    contradictions,
    recentChanges: audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    markdown,
  };
}

/** Insert AI drafts as PENDING, skipping content that duplicates an ACTIVE
 *  entry or an existing pending proposal. Returns the number created. */
export async function createProposals(
  userId: string,
  drafts: SoulProposalDraft[],
  evidence?: unknown,
): Promise<number> {
  if (drafts.length === 0) return 0;
  const [active, pending] = await Promise.all([
    db.soulEntry.findMany({ where: { userId, status: 'ACTIVE' }, select: { content: true } }),
    db.soulProposal.findMany({ where: { userId, status: 'PENDING' }, select: { content: true } }),
  ]);
  const existing = [...active, ...pending].map((r) => r.content);
  const fresh: SoulProposalDraft[] = [];
  for (const d of drafts) {
    const dupExisting = existing.some((c) => similarity(c, d.content) >= DUPLICATE_THRESHOLD);
    const dupBatch = fresh.some((f) => similarity(f.content, d.content) >= DUPLICATE_THRESHOLD);
    if (!dupExisting && !dupBatch) fresh.push(d);
  }
  if (fresh.length === 0) return 0;
  await db.soulProposal.createMany({
    data: fresh.map((d) => ({
      userId,
      section: d.section,
      content: d.content,
      reason: d.reason,
      evidence: (evidence ?? undefined) as object | undefined,
    })),
  });
  return fresh.length;
}

type DecisionResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      conflict?: { id: string; content: string; axis?: string };
    };

/**
 * Accept (optionally edit) a pending proposal → SoulEntry. Gates, in order:
 *   1. content firewall (style-only; a user edit can't smuggle data),
 *   2. contradiction with an ACTIVE entry (same section, opposite pole),
 *   3. near-duplicate of an ACTIVE entry.
 * On (2)/(3) it returns 409 with the conflicting entry so the UI can ask which
 * wins. Pass `archiveConflictId` (= the conflicting entry's id) to resolve
 * "new wins": the old entry is archived in the same transaction.
 */
export async function acceptProposal(
  userId: string,
  proposalId: string,
  contentOverride?: string,
  archiveConflictId?: string,
): Promise<DecisionResult> {
  const proposal = await db.soulProposal.findFirst({
    where: { id: proposalId, userId, status: 'PENDING' },
  });
  if (!proposal) {
    return { ok: false, status: 404, error: 'not_found', message: 'Vorschlag nicht gefunden.' };
  }
  const edited = contentOverride != null && contentOverride.trim() !== proposal.content.trim();
  const content = (contentOverride ?? proposal.content).trim();

  const fwReason = firewallReason(content);
  if (fwReason) {
    return {
      ok: false,
      status: 400,
      error: 'firewall_blocked',
      message: `Inhalt abgelehnt (${fwReason}). Soul speichert nur Stil-Präferenzen.`,
    };
  }

  const active: GovEntry[] = (await listActiveEntries(userId)).map((e) => ({
    id: e.id,
    section: e.section,
    content: e.content,
  }));

  const conflict = findConflict(content, proposal.section, active);
  const dup = active.find((e) => similarity(e.content, content) >= DUPLICATE_THRESHOLD);
  const blocker = conflict
    ? { type: 'contradiction', id: conflict.entry.id, content: conflict.entry.content, axis: conflict.axis }
    : dup
      ? { type: 'duplicate', id: dup.id, content: dup.content, axis: undefined }
      : null;

  if (blocker && archiveConflictId !== blocker.id) {
    return {
      ok: false,
      status: 409,
      error: blocker.type,
      message:
        blocker.type === 'contradiction'
          ? `Widerspruch zu einer bestehenden Präferenz (Achse: ${blocker.axis}). Welche soll gelten?`
          : 'Es existiert bereits eine sehr ähnliche Präferenz. Ersetzen?',
      conflict: { id: blocker.id, content: blocker.content, axis: blocker.axis },
    };
  }

  const ops = [];
  if (archiveConflictId) {
    ops.push(
      db.soulEntry.updateMany({
        where: { id: archiveConflictId, userId },
        data: { status: 'ARCHIVED' },
      }),
      db.soulAudit.create({
        data: { userId, action: 'archived', section: proposal.section, content: blocker?.content ?? '' },
      }),
    );
  }
  ops.push(
    db.soulEntry.create({ data: { userId, section: proposal.section, content } }),
    db.soulProposal.update({
      where: { id: proposalId },
      data: { status: edited ? 'EDITED' : 'ACCEPTED', decidedAt: new Date() },
    }),
    db.soulAudit.create({
      data: { userId, action: edited ? 'edited' : 'accepted', section: proposal.section, content },
    }),
  );
  await db.$transaction(ops);
  return { ok: true };
}

export async function rejectProposal(userId: string, proposalId: string): Promise<DecisionResult> {
  const proposal = await db.soulProposal.findFirst({
    where: { id: proposalId, userId, status: 'PENDING' },
  });
  if (!proposal) {
    return { ok: false, status: 404, error: 'not_found', message: 'Vorschlag nicht gefunden.' };
  }
  await db.$transaction([
    db.soulProposal.update({
      where: { id: proposalId },
      data: { status: 'REJECTED', decidedAt: new Date() },
    }),
    db.soulAudit.create({
      data: { userId, action: 'rejected', section: proposal.section, content: proposal.content },
    }),
  ]);
  return { ok: true };
}

/** Lifecycle transition on an entry: confirm (re-freshen), archive, or restore. */
export async function transitionEntry(
  userId: string,
  entryId: string,
  action: 'confirm' | 'archive' | 'restore',
): Promise<DecisionResult> {
  const entry = await db.soulEntry.findFirst({ where: { id: entryId, userId } });
  if (!entry) {
    return { ok: false, status: 404, error: 'not_found', message: 'Eintrag nicht gefunden.' };
  }
  const data =
    action === 'confirm'
      ? { lastConfirmedAt: new Date(), status: 'ACTIVE' as const }
      : action === 'archive'
        ? { status: 'ARCHIVED' as const }
        : { status: 'ACTIVE' as const, lastConfirmedAt: new Date() }; // restore
  const auditAction = action === 'confirm' ? 'confirmed' : action === 'archive' ? 'archived' : 'restored';
  await db.$transaction([
    db.soulEntry.update({ where: { id: entryId }, data }),
    db.soulAudit.create({ data: { userId, action: auditAction, section: entry.section, content: entry.content } }),
  ]);
  return { ok: true };
}

/** Hard-remove an entry. Writes an audit row. */
export async function revokeEntry(userId: string, entryId: string): Promise<DecisionResult> {
  const entry = await db.soulEntry.findFirst({ where: { id: entryId, userId } });
  if (!entry) {
    return { ok: false, status: 404, error: 'not_found', message: 'Eintrag nicht gefunden.' };
  }
  await db.$transaction([
    db.soulEntry.delete({ where: { id: entryId } }),
    db.soulAudit.create({ data: { userId, action: 'removed', section: entry.section, content: entry.content } }),
  ]);
  return { ok: true };
}
