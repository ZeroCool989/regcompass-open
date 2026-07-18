import { KB } from '@/lib/kb';
import { CATEGORY_LABELS, label } from '@/lib/kb/labels';
import type { Requirement } from '@/lib/kb/types';

/**
 * The typed domain object every gap finding is built into BEFORE any Excel cell
 * is written. The analysis engine produces these; the Excel exporter maps each
 * property explicitly into a template column (never by position). Keeping the
 * shape rich + validated is what makes the export consulting-grade rather than a
 * sparse grid of enum values.
 */
export type GapStatus = 'covered' | 'partial' | 'missing' | 'not_applicable';
export type Severity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface GapFinding {
  /** Stable, human-facing finding id (e.g. "GAP-001"). NOT the KB requirement id. */
  id: string;
  /** Display regulation name (e.g. "DORA", "EU AI Act"). */
  regulation: string;
  /** Article / paragraph reference (e.g. "Art. 12"). */
  article: string;
  /** KB requirement id this finding was assessed against (e.g. "R-DORA-014"). */
  requirementId: string;
  requirementTitle: string;
  /** Human-readable thematic area (from the requirement category). */
  requirementArea: string;
  /** Where in the policy the evidence sits (nearest heading), or "" if unknown. */
  policySection: string;
  /** 1-based page, when derivable. Usually absent for concatenated text. */
  pageNumber?: number;
  /** Quote/paraphrase from the policy (or an explicit absence note for gaps). */
  policyExcerpt: string;
  status: GapStatus;
  /** Specific description of what is missing/partial — never a generic stub. */
  gapDescription: string;
  /** Narrative risk/impact statement — never just the severity word. */
  riskImpact: string;
  severity: Severity;
  /** Actionable, implementation-oriented remediation referencing the article. */
  recommendation: string;
  /** Basis for the assessment (policy nexus + KB control reference). */
  evidence: string;
  /** Citation ids: KB requirement id, regulation:article, control standards. */
  citations: string[];
  /** Heuristic confidence in the assessment, 0..1. */
  confidence: number;
  /** Explainability: why this requirement was classified the way it was. */
  reason: string;
  /** True when confidence is below threshold — held for manual review, not auto-exported. */
  manualReview?: boolean;
  /** True when a core-DORA manual-review finding was promoted into the export set. */
  promoted?: boolean;
  /** True when the semantic pass found the policy CONTRADICTING the requirement
   * (verified quote in policyExcerpt; rationale in reason). */
  contradiction?: boolean;
  owner?: string;
  targetDate?: string;
}

const REG_SHORT = new Map(KB.regulations.map((r) => [r.id, r.shortName]));

/** Display short name for a regulation enum value (e.g. EU_AI_ACT → "EU AI Act"). */
export function regulationShortName(regulation: string): string {
  return REG_SHORT.get(regulation) ?? regulation.replace(/_/g, ' ');
}
const regShort = regulationShortName;

/** Prefer the German translation when present (the product is German-first). */
function de(primary: string | undefined, fallback: string): string {
  const v = (primary ?? '').trim();
  return v.length > 0 ? v : fallback;
}

function trimSentence(text: string, max = 260): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trim() + ' …';
}

/** Standard absence text used when no usable positive policy evidence exists. */
export const NO_POLICY_EXCERPT = 'Keine relevante Policy-Textstelle identifiziert.';
export const NO_POLICY_EVIDENCE = 'Kein hinreichender Nachweis in der Policy für diese Anforderung gefunden.';

// Excerpt quality gate — reject snippets pulled from non-substantive parts of a
// policy (cover page, classification banner, version history, TOC, footers,
// glossaries, bare headings, short role fragments).
const BAD_EXCERPT_RE: RegExp[] = [
  /classification|klassifizierung|vertraulichkeitsstufe/i,
  /version\s*history|versionshistorie|änderungshistorie|change\s*log|revision\s*history/i,
  /table of contents|inhaltsverzeichnis/i,
  /\bpage \d+\b|\bseite \d+\b|confidential|vertraulich|©|copyright/i,
  /\bappendix\b|\banhang\b|glossar|glossary/i,
  // Dated version-history line, e.g. "3.2 17 Mar 2026 CISO Updated …".
  /\b\d{1,2}\.?\s+(jan|feb|mar|mär|apr|may|mai|jun|jul|aug|sep|oct|okt|nov|dec|dez)\w*\.?\s+\d{4}\b/i,
  /\.{4,}/, // TOC dotted leaders
];

/** True when an excerpt is a substantive, credible policy quote (demo gate). */
export function isUsableExcerpt(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 40) return false; // headings / fragments like "Monitoring"
  if (t.split(/\s+/).length < 6) return false; // "ensures second-line independence"
  if (/[:：]\s*$/.test(t)) return false; // heading line ending in a colon
  return !BAD_EXCERPT_RE.some((re) => re.test(t));
}

const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/**
 * Inherent severity of the requirement, independent of status — driven by its
 * financial-sector relevance and binding level.
 */
export function deriveSeverity(req: Requirement): Severity {
  if (req.relevanceForFinancialSector === 'critical') return 'Critical';
  if (req.relevanceForFinancialSector === 'high') {
    return req.bindingLevel === 'mandatory' ? 'High' : 'High';
  }
  if (req.bindingLevel === 'mandatory' && req.relevanceForFinancialSector === 'medium') return 'High';
  if (req.relevanceForFinancialSector === 'medium') return 'Medium';
  return 'Low';
}

export function deriveRequirementArea(req: Requirement): string {
  return label(CATEGORY_LABELS, req.category);
}

/**
 * Consulting-grade remediation. Built from the requirement's KB controls
 * (action + concrete implementation steps), always anchored to the article —
 * never "Implement controls for X".
 */
export function buildRecommendation(req: Requirement): string {
  const ref = `${regShort(req.regulation)} ${req.article}`.trim();

  if (req.controls.length > 0) {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const top = [...req.controls]
      .sort((a, b) => order[a.priority] - order[b.priority])
      .slice(0, 2);
    const parts = top.map((c) => {
      const action = de(c.actionDe, c.action).replace(/\.$/, '');
      const steps = (c.implementationStepsDe ?? c.implementationSteps) ?? [];
      const stepStr = steps.length > 0 ? ` Konkrete Schritte: ${steps.slice(0, 4).join('; ')}.` : '';
      return `${action}.${stepStr}`;
    });
    return `${parts.join(' ')} Umsetzung und Dokumentation gemäss ${ref}.`;
  }

  // No controls in the KB for this requirement → derive a specific action from
  // the requirement itself rather than falling back to a placeholder.
  const title = de(req.titleDe, req.title);
  const summary = trimSentence(de(req.summaryDe, req.summary), 200);
  return `${title} gemäss ${ref} etablieren, formal verankern und regelmässig überprüfen: ${summary}`;
}

/** Narrative risk/impact, grounded in the requirement's enforcement consequence. */
export function buildRiskImpact(req: Requirement): string {
  const title = de(req.titleDe, req.title);
  const consequence = trimSentence(de(req.enforcementConsequenceDe, req.enforcementConsequence), 240);
  // Only append the sector guidance when a German version exists — never leak an
  // English-only guidance string into the German deliverable.
  const guidance = (req.financialSectorGuidanceDe ?? '').trim();
  let out = `Ohne angemessene Umsetzung von „${title}“: ${consequence}`;
  if (guidance) out += ` ${trimSentence(guidance, 160)}`;
  return out;
}

function buildGapDescription(req: Requirement, status: GapStatus): string {
  const title = de(req.titleDe, req.title);
  const area = deriveRequirementArea(req);
  const summary = trimSentence(de(req.summaryDe, req.summary), 220);
  switch (status) {
    case 'missing':
      return `Das Dokument adressiert „${title}“ (${area}) nicht. Erwartet wird: ${summary}`;
    case 'partial':
      return `„${title}“ ist nur teilweise bzw. unspezifisch abgedeckt; substanzielle Aspekte fehlen oder bleiben vage. Erwartet wird: ${summary}`;
    case 'not_applicable':
      return `„${title}“ ist im vorliegenden Kontext nicht anwendbar.`;
    case 'covered':
      return `„${title}“ ist im Dokument adressiert.`;
  }
}

function buildEvidence(req: Requirement, status: GapStatus, policyExcerpt: string): string {
  const title = de(req.titleDe, req.title);
  const controlRef = req.controls.find((c) => c.standard && c.standardClause);
  const kbRef = controlRef
    ? ` Kontrollrahmen: ${controlRef.standard} ${controlRef.standardClause}.`
    : '';
  if (status === 'missing' || status === 'not_applicable') {
    return `Kein Nachweis im Dokument für ${req.id} („${title}“).${kbRef}`;
  }
  return `Policy-Nachweis: „${trimSentence(policyExcerpt, 180)}“. Bewertet gegen ${req.id} („${title}“).${kbRef}`;
}

export function buildCitations(req: Requirement): string[] {
  const cites = [req.id, `${regShort(req.regulation)} ${req.article}`.trim()];
  for (const c of req.controls) {
    if (c.standard && c.standardClause) cites.push(`${c.standard}:${c.standardClause}`);
  }
  return [...new Set(cites.filter(Boolean))];
}

export type BuildGapFindingInput = {
  req: Requirement;
  status: GapStatus;
  /** Confidence from the coverage engine, 0..1. */
  confidence: number;
  /** Explainability: why this requirement was classified the way it was. */
  reason: string;
  /** Positive policy evidence (a quoted sentence); empty when none was found. */
  policyExcerpt?: string;
  /** Negative-evidence note when there is no positive excerpt (e.g. the
   * "No relevant evidence found." marker). */
  negativeEvidence?: string;
  policySection?: string;
  pageNumber?: number;
  /** Held for manual review (below the confidence threshold). */
  manualReview?: boolean;
  /** Assigned later by the caller after sorting; defaults to a placeholder. */
  id?: string;
};

/**
 * Assemble a fully-populated GapFinding from a KB requirement + the coverage
 * engine's verdict (status, confidence, reason, evidence). Every field is
 * derived here so the exporter only has to map.
 */
export function buildGapFinding(input: BuildGapFindingInput): GapFinding {
  const { req, status } = input;
  const title = de(req.titleDe, req.title);

  // Quality gate: only keep a positive excerpt if it is a substantive, credible
  // policy quote. Junk (cover page, version history, TOC, headings, …) is
  // replaced by the standard absence text rather than shown in the deliverable.
  const rawExcerpt = (input.policyExcerpt ?? '').trim();
  const usable = rawExcerpt.length > 0 && isUsableExcerpt(rawExcerpt);
  const policyExcerpt = usable ? trimSentence(rawExcerpt, 320) : NO_POLICY_EXCERPT;
  const evidence = usable ? buildEvidence(req, status, rawExcerpt) : NO_POLICY_EVIDENCE;

  return {
    id: input.id ?? 'GAP-000',
    regulation: regShort(req.regulation),
    article: req.article,
    requirementId: req.id,
    requirementTitle: title,
    requirementArea: deriveRequirementArea(req),
    policySection: input.policySection ?? '',
    pageNumber: input.pageNumber,
    policyExcerpt,
    status,
    gapDescription: buildGapDescription(req, status),
    riskImpact: buildRiskImpact(req),
    severity: deriveSeverity(req),
    recommendation: buildRecommendation(req),
    evidence,
    citations: buildCitations(req),
    confidence: Math.round(Math.min(1, Math.max(0, input.confidence)) * 100) / 100,
    reason: input.reason,
    manualReview: input.manualReview,
    owner: undefined,
    targetDate: undefined,
  };
}

/**
 * Suppress duplicate findings: collapse to one per KB requirement id (keeping the
 * highest-confidence variant), then drop any later finding sharing the same
 * regulation+article+status key.
 */
export function dedupeFindings(findings: GapFinding[]): GapFinding[] {
  const byReq = new Map<string, GapFinding>();
  for (const f of findings) {
    const prev = byReq.get(f.requirementId);
    if (!prev || f.confidence > prev.confidence) byReq.set(f.requirementId, f);
  }
  const seen = new Set<string>();
  const out: GapFinding[] = [];
  for (const f of byReq.values()) {
    const key = `${f.regulation}|${f.article}|${f.status}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// ─────────────────────────── Validation ───────────────────────────

export type GapFindingValidation = { ok: boolean; errors: string[] };

const PLACEHOLDER_RECOMMENDATION = /^\s*implement\s+controls?\b/i;
const VALID_STATUS: GapStatus[] = ['covered', 'partial', 'missing', 'not_applicable'];
const VALID_SEVERITY: Severity[] = ['Low', 'Medium', 'High', 'Critical'];

/**
 * Reject findings that would produce empty or wrong cells. Required fields must
 * be present; the recommendation must not be a placeholder; status/severity must
 * be valid enum values; confidence must be in range.
 */
export function validateGapFinding(f: GapFinding): GapFindingValidation {
  const errors: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
  };

  need(!!f.id?.trim(), 'missing id');
  need(!!f.regulation?.trim(), 'missing regulation');
  need(!!f.article?.trim(), 'missing article');
  need(!!f.requirementId?.trim(), 'missing requirementId');
  need(!!f.requirementTitle?.trim(), 'missing requirementTitle');
  need(!!f.requirementArea?.trim(), 'missing requirementArea');
  need(!!f.policyExcerpt?.trim(), 'missing policyExcerpt');
  need(!!f.gapDescription?.trim(), 'missing gapDescription');
  need(!!f.riskImpact?.trim(), 'missing riskImpact');
  need(VALID_STATUS.includes(f.status), 'missing/invalid status');
  need(VALID_SEVERITY.includes(f.severity), 'missing/invalid severity');
  need(!!f.evidence?.trim(), 'missing evidence');
  need(Array.isArray(f.citations) && f.citations.length > 0, 'missing citations');
  need(
    !!f.recommendation?.trim() &&
      !PLACEHOLDER_RECOMMENDATION.test(f.recommendation) &&
      f.recommendation.trim().length >= 25,
    'missing/placeholder recommendation',
  );
  need(
    typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1,
    'invalid confidence',
  );
  need(!!f.reason?.trim(), 'missing reason');

  return { ok: errors.length === 0, errors };
}
