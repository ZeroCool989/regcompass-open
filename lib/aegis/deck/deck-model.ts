import { KB } from '@/lib/kb';
import type { Requirement } from '@/lib/kb/types';
import { auditSnapshotLine } from '../provenance';
import {
  regulationShortName,
  severityRank,
  type GapFinding,
  type GapStatus,
  type Severity,
} from '../gap-finding';

/**
 * Pure data layer for the "PowerPoint Management Summary" (generate_assessment_deck).
 *
 * ANTI-HALLUCINATION CONTRACT: every regulatory fact on the deck (article,
 * binding level, obligation text, control, severity, source) is resolved here
 * from STRUCTURED data only — the saved GapFindings and the curated KB. The
 * model never supplies regulatory prose: it may pass requirement IDs (validated
 * against the KB; unknown ones are dropped) and non-regulatory framing (title,
 * scope/use-case, a risk-classification rationale). If nothing structured can be
 * resolved, `buildDeckModel` returns null and the tool refuses to invent a deck.
 */

export const SEVERITY_LABEL_DE: Record<Severity, string> = {
  Critical: 'Kritisch',
  High: 'Hoch',
  Medium: 'Mittel',
  Low: 'Niedrig',
};

export const STATUS_LABEL_DE: Record<GapStatus, string> = {
  covered: 'Erfüllt',
  partial: 'Teilweise',
  missing: 'Nicht erfüllt',
  not_applicable: 'Nicht anwendbar',
};

const BINDING_LABEL_DE: Record<string, string> = {
  mandatory: 'Verpflichtend',
  supervisory_expectation: 'Aufsichtserwartung',
  best_practice: 'Best Practice',
};

const RELEVANCE_LABEL_DE: Record<string, string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

// Caps keep the deck readable (and the file small) regardless of input size.
const OBLIGATION_CAP = 14;
const CONTROL_CAP = 14;
const FINDING_CAP = 20;
const TOP_RISKS = 5;
const ROADMAP_ITEMS_PER_PHASE = 6;
const SOURCES_CAP = 30;

function de(german: string | undefined, fallback: string): string {
  return german && german.trim() ? german : fallback;
}

function trim(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ───────────────────────── Model types ─────────────────────────

export type DeckFinding = {
  id: string;
  regulation: string;
  article: string;
  requirementId: string;
  title: string;
  status: GapStatus;
  severity: Severity;
  gap: string;
  risk: string;
  recommendation: string;
  citations: string[];
};

export type DeckObligation = {
  requirementId: string;
  regulation: string;
  article: string;
  title: string;
  bindingLevel: string;
  relevance: string;
  enforcementConsequence: string;
  sourceUrl?: string;
  sourceFile?: string;
};

export type DeckControl = {
  requirementId: string;
  regulation: string;
  article: string;
  action: string;
  priority: string;
  steps: string[];
};

export type DeckSource = {
  requirementId: string;
  regulation: string;
  article: string;
  url?: string;
  pdf?: string;
  provenance: string;
  /** Verification status label (✓ manually verified / ⚠ machine-extracted). */
  verification: string;
};

export type DeckHeatmapRow = { regulation: string; counts: Record<Severity, number>; total: number };

/**
 * One regulatory-radar news item shown on the optional "Regulatorischer
 * Ausblick" slide. Echoes the stored, source-verified news verbatim — no
 * AEGIS-generated rating (news has no severity). The impure boundary (executor)
 * fetches + formats these; the builder only passes them through.
 */
export type DeckOutlookItem = {
  title: string;
  source: string;
  dateLabel: string;
  relevance: string;
  url: string;
};

export type DeckModel = {
  title: string;
  subtitle: string;
  generatedAtLabel: string;
  scope: string;
  riskClassification: { tier: string; rationale: string; drivenBy: string[] } | null;
  executive: {
    totalFindings: number;
    bySeverity: Record<Severity, number>;
    byStatus: Record<GapStatus, number>;
    topRisks: DeckFinding[];
    headline: string;
  };
  findings: DeckFinding[];
  heatmap: DeckHeatmapRow[];
  obligations: DeckObligation[];
  controls: DeckControl[];
  roadmap: { phase: string; items: string[] }[];
  sources: DeckSource[];
  /** Optional regulatory-radar items (opt-in); empty unless requested. */
  outlook: DeckOutlookItem[];
  /** KB audit snapshot (version, verification coverage, checksum status). */
  auditLine: string;
};

export type BuildDeckInput = {
  title?: string;
  clientName?: string;
  scope?: string;
  riskClassification?: { tier?: string; rationale?: string; drivenBy?: string[] };
  /** Structured findings from a prior gap analysis (findings-store). */
  findings?: GapFinding[];
  /** Additional cited requirement IDs (ASSESS path) — validated against the KB. */
  requirementIds?: string[];
  /** Caller-provided date label (kept out of the pure builder for testability). */
  generatedAtLabel: string;
  /**
   * Optional regulatory outlook (opt-in via the tool). The executor fetches +
   * formats these from the radar; the builder only passes them through (news is
   * already source-verified, so no KB validation here).
   */
  outlook?: DeckOutlookItem[];
};

// ───────────────────────── Builder ─────────────────────────

function obligationFromReq(req: Requirement): DeckObligation {
  return {
    requirementId: req.id,
    regulation: regulationShortName(req.regulation),
    article: req.article,
    title: de(req.titleDe, req.title),
    bindingLevel: BINDING_LABEL_DE[req.bindingLevel] ?? req.bindingLevel,
    relevance: RELEVANCE_LABEL_DE[req.relevanceForFinancialSector] ?? req.relevanceForFinancialSector,
    enforcementConsequence: trim(de(req.enforcementConsequenceDe, req.enforcementConsequence), 240),
    sourceUrl: req.sourceUrl ?? undefined,
    sourceFile: req.sourceFile ?? undefined,
  };
}

/**
 * Build the deck model from structured inputs only. Returns null when there is
 * nothing grounded to present (no findings AND no resolvable requirement IDs).
 */
export function buildDeckModel(input: BuildDeckInput): DeckModel | null {
  const findings = input.findings ?? [];

  // 1) Resolve the obligation/control universe from the KB (drop unknown IDs).
  const idSet = new Set<string>();
  for (const f of findings) if (f.requirementId) idSet.add(f.requirementId);
  for (const id of input.requirementIds ?? []) if (id) idSet.add(id.trim());

  const resolved: Requirement[] = [];
  for (const id of idSet) {
    const req = KB.byId(id);
    if (req) resolved.push(req); // unknown id → silently dropped (anti-hallucination)
  }

  if (findings.length === 0 && resolved.length === 0) return null;

  // 2) Findings (sorted by severity, then non-covered first).
  const deckFindings: DeckFinding[] = [...findings]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || statusRank(a.status) - statusRank(b.status))
    .slice(0, FINDING_CAP)
    .map((f) => ({
      id: f.id,
      regulation: f.regulation,
      article: f.article,
      requirementId: f.requirementId,
      title: f.requirementTitle,
      status: f.status,
      severity: f.severity,
      gap: trim(f.gapDescription, 220),
      risk: trim(f.riskImpact, 220),
      recommendation: trim(f.recommendation, 240),
      citations: f.citations ?? [],
    }));

  // 3) Aggregates for the executive summary + heatmap.
  const bySeverity = zeroSeverity();
  const byStatus: Record<GapStatus, number> = { covered: 0, partial: 0, missing: 0, not_applicable: 0 };
  const heatmapMap = new Map<string, Record<Severity, number>>();
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    byStatus[f.status] += 1;
    const row = heatmapMap.get(f.regulation) ?? zeroSeverity();
    row[f.severity] += 1;
    heatmapMap.set(f.regulation, row);
  }
  const heatmap: DeckHeatmapRow[] = [...heatmapMap.entries()]
    .map(([regulation, counts]) => ({ regulation, counts, total: SEVERITIES.reduce((n, s) => n + counts[s], 0) }))
    .sort((a, b) => b.total - a.total);

  const topRisks = deckFindings.filter((f) => f.severity === 'Critical' || f.severity === 'High').slice(0, TOP_RISKS);

  // 4) Obligations + controls (from resolved KB requirements).
  const obligations = resolved
    .slice()
    .sort((a, b) => bindingWeight(a) - bindingWeight(b))
    .slice(0, OBLIGATION_CAP)
    .map(obligationFromReq);

  const controls: DeckControl[] = [];
  for (const req of resolved) {
    for (const c of req.controls ?? []) {
      controls.push({
        requirementId: req.id,
        regulation: regulationShortName(req.regulation),
        article: req.article,
        action: trim(de(c.actionDe, c.action), 160),
        priority: c.priority,
        steps: (c.implementationStepsDe ?? c.implementationSteps ?? []).slice(0, 4).map((s) => trim(s, 160)),
      });
    }
  }
  controls.sort((a, b) => controlPriorityRank(a.priority) - controlPriorityRank(b.priority));
  const cappedControls = controls.slice(0, CONTROL_CAP);

  // 5) Roadmap — severity-driven phases from the findings' recommendations.
  const roadmap = buildRoadmap(deckFindings);

  // 6) Sources / audit trail — every resolved obligation + finding citation.
  const sources = buildSources(resolved, findings).slice(0, SOURCES_CAP);

  // 7) Risk classification (model framing) — drivenBy IDs filtered to KB-known.
  const rc = input.riskClassification;
  const riskClassification = rc && (rc.tier || rc.rationale)
    ? {
        tier: trim(rc.tier ?? '—', 80),
        rationale: trim(rc.rationale ?? '', 400),
        drivenBy: (rc.drivenBy ?? []).filter((id) => !!KB.byId(id)),
      }
    : null;

  const total = findings.length;
  const headline = total > 0
    ? `${total} bewertete Anforderungen · ${bySeverity.Critical} kritisch · ${bySeverity.High} hoch · ${byStatus.missing} nicht erfüllt`
    : `${resolved.length} regulatorische Anforderungen im Geltungsbereich`;

  return {
    title: trim(input.title?.trim() || 'AEGIS Management Summary', 120),
    subtitle: input.clientName?.trim() ? trim(input.clientName.trim(), 120) : 'Regulatorische Bewertung',
    generatedAtLabel: input.generatedAtLabel,
    scope: trim(input.scope?.trim() || 'Kein Geltungsbereich angegeben.', 600),
    riskClassification,
    executive: { totalFindings: total, bySeverity, byStatus, topRisks, headline },
    findings: deckFindings,
    heatmap,
    obligations,
    controls: cappedControls,
    roadmap,
    sources,
    outlook: input.outlook ?? [],
    auditLine: auditSnapshotLine('de'),
  };
}

// ───────────────────────── helpers ─────────────────────────

function zeroSeverity(): Record<Severity, number> {
  return { Critical: 0, High: 0, Medium: 0, Low: 0 };
}

function statusRank(s: GapStatus): number {
  return { missing: 0, partial: 1, covered: 2, not_applicable: 3 }[s];
}

function bindingWeight(req: Requirement): number {
  return { mandatory: 0, supervisory_expectation: 1, best_practice: 2 }[req.bindingLevel] ?? 3;
}

function controlPriorityRank(p: string): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[p.toLowerCase()] ?? 4;
}

function buildRoadmap(findings: DeckFinding[]): { phase: string; items: string[] }[] {
  const phases: { phase: string; sev: Severity[] }[] = [
    { phase: 'Sofortmaßnahmen (kritisch)', sev: ['Critical'] },
    { phase: 'Kurzfristig (hoch)', sev: ['High'] },
    { phase: 'Mittel- bis langfristig (mittel/niedrig)', sev: ['Medium', 'Low'] },
  ];
  const out: { phase: string; items: string[] }[] = [];
  for (const p of phases) {
    const items = findings
      .filter((f) => p.sev.includes(f.severity) && (f.status === 'missing' || f.status === 'partial'))
      .slice(0, ROADMAP_ITEMS_PER_PHASE)
      .map((f) => `${f.regulation} ${f.article}: ${f.recommendation}`);
    if (items.length) out.push({ phase: p.phase, items });
  }
  return out;
}

function buildSources(resolved: Requirement[], findings: GapFinding[]): DeckSource[] {
  const seen = new Set<string>();
  const sources: DeckSource[] = [];
  const push = (req: Requirement) => {
    if (seen.has(req.id)) return;
    seen.add(req.id);
    sources.push({
      requirementId: req.id,
      regulation: regulationShortName(req.regulation),
      article: req.article,
      url: req.sourceUrl ?? undefined,
      pdf: req.sourceFile ?? undefined,
      provenance: 'Kuratierte Wissensbasis',
      verification: req.verified
        ? `✓ manuell verifiziert${req.verifiedAt ? ` (${req.verifiedAt})` : ''}`
        : '⚠ maschinell extrahiert, nicht manuell verifiziert',
    });
  };
  for (const req of resolved) push(req);
  // Pull in any finding citation IDs not already covered (still KB-validated).
  for (const f of findings) {
    for (const cid of f.citations ?? []) {
      const req = KB.byId(cid);
      if (req) push(req);
    }
  }
  return sources;
}
