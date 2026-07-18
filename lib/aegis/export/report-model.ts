import { KB } from '@/lib/kb';
import {
  validateGapFinding,
  regulationShortName,
  severityRank,
  type GapFinding,
  type GapStatus,
  type Severity,
} from '../gap-finding';
import { auditSnapshotLine } from '../provenance';
import { HUMAN_IN_THE_LOOP_NOTE, SEVERITY_LABEL, STATUS_LABEL } from '../parsers/excel-writer';
import type { FillSourceRef } from '../tools/fill_template';

/**
 * Canonical assessment-report model — the single deterministic source every
 * export builder (XLSX, DOCX, PDF) consumes. Built ONCE from validated
 * findings; the builders only lay out, they never re-derive, re-grade or
 * invent content (docs/CLAUDE.md: severity/classification come from the KB +
 * deterministic derivation, citations must resolve via KB.byId).
 */

export type CitedRequirementStatus = {
  id: string;
  /** Display reference, e.g. "DORA Art. 24". */
  ref: string;
  title: string;
  verified: boolean;
  /** KB verificationMethod (e.g. manual-source-verification, dual-agent-source-verification). */
  method: string;
  verifiedAt: string | null;
  /** German one-line status, mirroring the chat citation footer wording. */
  labelDe: string;
};

export type AssessmentReportMeta = {
  title: string;
  generatedAt: Date;
  sourceRef: FillSourceRef | null;
  /** Distinct display regulations covered by the findings. */
  scope: string[];
};

export type AssessmentCounts = {
  total: number;
  byStatus: Record<GapStatus, number>;
  bySeverity: Record<Severity, number>;
  manualReview: number;
};

export type AssessmentReport = {
  meta: AssessmentReportMeta;
  findings: GapFinding[];
  /** Findings rejected by validateGapFinding — reported, never exported. */
  rejected: { id: string; errors: string[] }[];
  counts: AssessmentCounts;
  citedRequirements: CitedRequirementStatus[];
  /** Citation ids that do NOT resolve in the KB (must be none for delivery). */
  unresolvedCitations: string[];
  auditLineDe: string;
  humanNoteDe: string;
};

const KB_ID_RE = /^R-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;

/** German status line per cited KB entry — same provenance semantics as chat. */
function citedStatusDe(id: string): CitedRequirementStatus | null {
  const req = KB.byId(id);
  if (!req) return null;
  const ref = `${regulationShortName(req.regulation)} ${req.article}`.trim();
  const when = req.verifiedAt ? ` (${req.verifiedAt})` : '';
  let labelDe: string;
  if (req.verified) {
    labelDe =
      req.verificationMethod === 'dual-agent-source-verification'
        ? `✓ zweifach unabhängig gegen Primärquelle verifiziert (KI-gestützt)${when}`
        : `✓ manuell gegen Primärquelle verifiziert${when}`;
  } else {
    labelDe = '⚠ maschinell extrahiert, noch nicht manuell verifiziert';
  }
  return {
    id,
    ref,
    title: (req.titleDe?.trim() || req.title || '').trim(),
    verified: req.verified === true,
    method: req.verificationMethod ?? '',
    verifiedAt: req.verifiedAt ?? null,
    labelDe,
  };
}

export type BuildReportInput = {
  findings: GapFinding[];
  title?: string;
  sourceRef?: FillSourceRef | null;
};

const EMPTY_STATUS: Record<GapStatus, number> = {
  covered: 0,
  partial: 0,
  missing: 0,
  not_applicable: 0,
};
const EMPTY_SEVERITY: Record<Severity, number> = {
  Critical: 0,
  High: 0,
  Medium: 0,
  Low: 0,
};

/**
 * Validate + order findings, resolve every citation against the KB and compute
 * all counts. Deterministic TS only — no model involvement anywhere in export.
 */
export function buildReportModel(input: BuildReportInput): AssessmentReport {
  const valid: GapFinding[] = [];
  const rejected: { id: string; errors: string[] }[] = [];
  for (const f of input.findings) {
    const res = validateGapFinding(f);
    if (res.ok) valid.push(f);
    else rejected.push({ id: f?.id ?? '(ohne id)', errors: res.errors });
  }

  // Stable deliverable order: severity (Critical first), then status
  // (missing → partial → covered → n/a), then finding id.
  const statusOrder: Record<GapStatus, number> = {
    missing: 0,
    partial: 1,
    covered: 2,
    not_applicable: 3,
  };
  const ordered = [...valid].sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    const st = statusOrder[a.status] - statusOrder[b.status];
    if (st !== 0) return st;
    return a.id.localeCompare(b.id);
  });

  const counts: AssessmentCounts = {
    total: ordered.length,
    byStatus: { ...EMPTY_STATUS },
    bySeverity: { ...EMPTY_SEVERITY },
    manualReview: 0,
  };
  const citedIds: string[] = [];
  const seenIds = new Set<string>();
  for (const f of ordered) {
    counts.byStatus[f.status] += 1;
    counts.bySeverity[f.severity] += 1;
    if (f.manualReview) counts.manualReview += 1;
    for (const c of [f.requirementId, ...f.citations]) {
      const id = (c ?? '').trim().replace(/^\[|\]$/g, '');
      if (KB_ID_RE.test(id) && !seenIds.has(id)) {
        seenIds.add(id);
        citedIds.push(id);
      }
    }
  }

  const citedRequirements: CitedRequirementStatus[] = [];
  const unresolvedCitations: string[] = [];
  for (const id of citedIds) {
    const status = citedStatusDe(id);
    if (status) citedRequirements.push(status);
    else unresolvedCitations.push(id);
  }

  const scope = [...new Set(ordered.map((f) => f.regulation).filter(Boolean))];

  return {
    meta: {
      title: input.title?.trim() || 'AEGIS Regulatorisches Assessment',
      generatedAt: new Date(),
      sourceRef: input.sourceRef ?? null,
      scope,
    },
    findings: ordered,
    rejected,
    counts,
    citedRequirements,
    unresolvedCitations,
    auditLineDe: auditSnapshotLine('de'),
    humanNoteDe: HUMAN_IN_THE_LOOP_NOTE,
  };
}

/** de-DE date for cover pages/filenames, e.g. "17.07.2026". */
export function fmtDateDe(d: Date): string {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Filename-safe timestamp, e.g. "2026-07-17". */
export function fmtDateFile(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { SEVERITY_LABEL, STATUS_LABEL };
