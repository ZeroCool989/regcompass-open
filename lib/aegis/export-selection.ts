import {
  severityRank,
  NO_POLICY_EXCERPT,
  NO_POLICY_EVIDENCE,
  type GapFinding,
} from './gap-finding';

/**
 * Export selection / MVP tuning layer. The Coverage Engine is precision-first:
 * it sends truly-absent requirements to manual review because there is no
 * positive evidence. For CORE DORA ICT obligations, however, absence is itself a
 * material gap. This layer rebalances precision↔recall for the demo WITHOUT
 * touching the engine: it exports the high-confidence partial/missing findings,
 * then promotes core-DORA manual-review findings (absence-as-evidence) until the
 * result lands in the 8–12 range, ranked and de-duplicated by topic.
 */

export const MIN_EXPORT = 8;
export const MAX_EXPORT = 10;

/**
 * Core DORA article numbers where absence is meaningful for an ICT risk policy.
 * Sanctions / authority powers / delegated acts / amendments / transitional /
 * entry-into-force / definitions are deliberately NOT here, so they are never
 * promoted (and are already filtered out by the applicability stage).
 */
const CORE_DORA_ARTICLES = new Set([5, 6, 8, 11, 12, 13, 17, 18, 19, 28, 29, 30]);

// Absence-as-evidence reason for promoted findings (German deliverable).
const ABSENCE_REASON =
  'Das Fehlen dieses Kontrollbereichs ist wesentlich, da die Anforderung eine zentrale DORA-Pflicht zum IKT-Risikomanagement betrifft.';

function articleNumber(article: string): number | null {
  const m = article.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** A core-DORA obligation (by regulation + article number). */
export function isCoreDora(f: GapFinding): boolean {
  if (f.regulation !== 'DORA') return false; // display short name
  const n = articleNumber(f.article);
  return n != null && CORE_DORA_ARTICLES.has(n);
}

/** Topic key for de-duplication: one slot per core DORA article, else per requirement. */
function topicKey(f: GapFinding): string {
  const n = articleNumber(f.article);
  if (f.regulation === 'DORA' && n != null && CORE_DORA_ARTICLES.has(n)) return `DORA:${n}`;
  return `${f.regulation}:${f.requirementId}`;
}

/** Partial findings always carry a positive policy excerpt (engine guarantee). */
function hasPositiveEvidence(f: GapFinding): boolean {
  return f.status === 'partial';
}

/**
 * Ranking (spec order): core relevance → status (missing↑) → severity →
 * confidence → evidence quality → stable id.
 */
function rankCompare(a: GapFinding, b: GapFinding): number {
  const core = Number(isCoreDora(b)) - Number(isCoreDora(a));
  if (core !== 0) return core;
  const status = Number(a.status === 'missing') - Number(b.status === 'missing');
  if (status !== 0) return -status; // missing first
  const sev = severityRank(a.severity) - severityRank(b.severity); // Critical first
  if (sev !== 0) return sev;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const ev = Number(hasPositiveEvidence(b)) - Number(hasPositiveEvidence(a));
  if (ev !== 0) return ev;
  return a.requirementId.localeCompare(b.requirementId);
}

/** Convert a core manual-review finding into an export-ready, absence-as-evidence one. */
function promote(f: GapFinding): GapFinding {
  if (hasPositiveEvidence(f)) {
    return { ...f, manualReview: false, promoted: true };
  }
  return {
    ...f,
    manualReview: false,
    promoted: true,
    policyExcerpt: NO_POLICY_EXCERPT,
    evidence: NO_POLICY_EVIDENCE,
    reason: ABSENCE_REASON,
  };
}

export type ExportSelection = {
  /** Final ranked, de-duplicated, capped export set (≤ MAX_EXPORT). */
  exported: GapFinding[];
  /** The subset of `exported` that came from manual review via promotion. */
  promoted: GapFinding[];
  /** Manual-review findings that were NOT promoted. */
  remainingReview: GapFinding[];
};

/**
 * Build the export set: auto-exportable findings first, then promoted core-DORA
 * manual-review findings to reach 8–12, de-duplicated by topic and capped.
 */
export function selectExportFindings(
  autoExport: GapFinding[],
  review: GapFinding[],
): ExportSelection {
  const usedTopics = new Set<string>();
  const chosen: GapFinding[] = [];

  // Demo filter: drop DORA findings that are NOT core ICT-policy articles
  // (Art. 3 definitions, Art. 7 generic ICT systems, Art. 10 detection, Art. 27
  // TLPT, Art. 31 designation, authority/meta articles, …) — these pass only on
  // keyword overlap and are demo noise. Non-DORA findings are kept as-is.
  const eligibleAuto = autoExport.filter((f) => f.regulation !== 'DORA' || isCoreDora(f));

  const tryAdd = (f: GapFinding): boolean => {
    const key = topicKey(f);
    if (usedTopics.has(key) || chosen.length >= MAX_EXPORT) return false;
    usedTopics.add(key);
    chosen.push(f);
    return true;
  };

  // 1. High-confidence partial/missing findings (already above threshold).
  for (const f of [...eligibleAuto].sort(rankCompare)) tryAdd(f);

  // 2. Promote core-DORA manual-review findings (absence is meaningful) until we
  //    reach the cap. Non-core / meta / authority findings are never promoted.
  const promoted: GapFinding[] = [];
  const coreReview = review.filter(isCoreDora).sort(rankCompare);
  for (const f of coreReview) {
    if (chosen.length >= MAX_EXPORT) break;
    if (usedTopics.has(topicKey(f))) continue;
    const pf = promote(f);
    usedTopics.add(topicKey(pf));
    chosen.push(pf);
    promoted.push(pf);
  }

  // 3. Final rank + cap.
  const exported = chosen.sort(rankCompare).slice(0, MAX_EXPORT);
  const exportedIds = new Set(exported.map((f) => f.requirementId));
  const promotedExported = promoted.filter((p) => exportedIds.has(p.requirementId));
  const remainingReview = review.filter((f) => !exportedIds.has(f.requirementId));

  return { exported, promoted: promotedExported, remainingReview };
}
