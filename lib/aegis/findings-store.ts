import { db } from '@/lib/db';
import type { GapFinding } from './tools/analyze_document';

/**
 * Cache of structured gap-analysis findings, so the GAP_ANALYZE step and the
 * later Excel-fill step are two separate, cheap requests instead of one long
 * turn that re-runs the full document analysis (the 4.5-min timeout case).
 *
 * Persistence reuses the existing `AegisDocument` table — no schema change. A
 * findings cache is just a row with `type = 'findings'` and a deterministic
 * `filename` key derived from the policy document id, so the second request can
 * look it up. It is session-scoped and shares the documents' 1h TTL, and it is
 * never surfaced to the UI or the download route (those go by row id).
 */

const FINDINGS_TYPE = 'findings';
// Match the document-store TTL (24h, override via AEGIS_DOCUMENT_TTL_HOURS) so a
// refresh between the analyze and fill steps still reuses the saved findings.
const EXPIRY_MS = (() => {
  const h = Number(process.env.AEGIS_DOCUMENT_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
})();

/** Deterministic lookup key tying a findings cache to its policy document. */
function keyFor(policyDocumentId: string): string {
  return `__aegis_findings__:${policyDocumentId}`;
}

/**
 * Persist the findings for a policy document. Replaces any prior cache for the
 * same (session, policy) so a re-analysis overwrites stale findings. Best-effort:
 * callers should not let a cache failure break the analysis turn.
 */
export async function saveFindings(
  sessionId: string | null,
  policyDocumentId: string,
  findings: GapFinding[],
): Promise<void> {
  if (!sessionId || !policyDocumentId) return;
  const filename = keyFor(policyDocumentId);
  const now = Date.now();
  await db.aegisDocument.deleteMany({
    where: { sessionId, type: FINDINGS_TYPE, filename },
  });
  await db.aegisDocument.create({
    data: {
      sessionId,
      filename,
      type: FINDINGS_TYPE,
      textContent: JSON.stringify(findings),
      expiresAt: new Date(now + EXPIRY_MS),
    },
  });
}

/**
 * Look up previously saved findings for a policy document. Returns `null` when
 * none exist (never analyzed, or expired) so the caller can fall back to a full
 * analysis.
 */
export async function getSavedFindings(
  sessionId: string | null,
  policyDocumentId: string,
): Promise<GapFinding[] | null> {
  if (!sessionId || !policyDocumentId) return null;
  const row = await db.aegisDocument.findFirst({
    where: {
      sessionId,
      type: FINDINGS_TYPE,
      filename: keyFor(policyDocumentId),
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  try {
    return JSON.parse(row.textContent) as GapFinding[];
  } catch {
    return null;
  }
}
