import { describe, it, expect } from 'vitest';
import { buildDeckModel } from '../deck/deck-model';
import type { GapFinding } from '../gap-finding';

const REAL_ID = 'R-AIACT-005'; // EU AI Act Art. 5 — exists in the curated KB
const FAKE_ID = 'R-FAKE-999';

const finding = (over: Partial<GapFinding> = {}): GapFinding => ({
  id: 'GAP-001',
  regulation: 'EU AI Act',
  article: 'Art. 5',
  requirementId: REAL_ID,
  requirementTitle: 'Prohibited AI Practices',
  requirementArea: 'Governance',
  policySection: '',
  policyExcerpt: 'Auszug.',
  status: 'missing',
  gapDescription: 'Keine Regelung zu verbotenen Praktiken.',
  riskImpact: 'Hohes regulatorisches Risiko.',
  severity: 'Critical',
  recommendation: 'Verbotene KI-Praktiken ausschließen.',
  evidence: 'Policy schweigt; KB R-AIACT-005.',
  citations: [REAL_ID],
  confidence: 0.9,
  reason: 'Pflicht, kritisch.',
  ...over,
});

const LABEL = 'June 2026';

describe('buildDeckModel — grounding + anti-hallucination', () => {
  it('returns null when there is nothing structured to present', () => {
    expect(buildDeckModel({ findings: [], requirementIds: [], generatedAtLabel: LABEL })).toBeNull();
  });

  it('builds obligations from the KB and DROPS unknown requirement ids', () => {
    const model = buildDeckModel({ findings: [], requirementIds: [REAL_ID, FAKE_ID], generatedAtLabel: LABEL });
    expect(model).not.toBeNull();
    const ids = model!.obligations.map((o) => o.requirementId);
    expect(ids).toContain(REAL_ID);
    expect(ids).not.toContain(FAKE_ID);
  });

  it('defaults outlook to [] and passes provided outlook through verbatim', () => {
    const base = buildDeckModel({ findings: [finding()], generatedAtLabel: LABEL });
    expect(base!.outlook).toEqual([]);

    const outlook = [
      { title: 'BaFin zu DORA', source: 'BaFin', dateLabel: '01. Juni 2026', relevance: 'Relevant.', url: 'https://bafin.de/x' },
    ];
    const model = buildDeckModel({ findings: [finding()], generatedAtLabel: LABEL, outlook });
    expect(model!.outlook).toEqual(outlook); // echo only — builder never alters news
  });

  it('aggregates severity counts + heatmap from findings', () => {
    const model = buildDeckModel({ findings: [finding(), finding({ id: 'GAP-002', severity: 'High' })], generatedAtLabel: LABEL });
    expect(model!.executive.bySeverity.Critical).toBe(1);
    expect(model!.executive.bySeverity.High).toBe(1);
    expect(model!.executive.totalFindings).toBe(2);
    expect(model!.heatmap.find((h) => h.regulation === 'EU AI Act')?.counts.Critical).toBe(1);
  });

  it('preserves source provenance for resolved obligations', () => {
    const model = buildDeckModel({ requirementIds: [REAL_ID], generatedAtLabel: LABEL });
    expect(model!.sources.length).toBeGreaterThan(0);
    const s = model!.sources.find((x) => x.requirementId === REAL_ID);
    expect(s).toBeDefined();
    expect(s!.provenance).toBe('Kuratierte Wissensbasis');
    expect(Boolean(s!.url || s!.pdf)).toBe(true);
  });

  it('filters riskClassification.drivenBy to KB-known ids', () => {
    const model = buildDeckModel({
      findings: [finding()],
      riskClassification: { tier: 'Hochrisiko', rationale: 'Anhang III', drivenBy: [REAL_ID, FAKE_ID] },
      generatedAtLabel: LABEL,
    });
    expect(model!.riskClassification?.drivenBy).toEqual([REAL_ID]);
  });

  it('builds a severity-ordered roadmap only from open findings', () => {
    const model = buildDeckModel({ findings: [finding({ status: 'missing', severity: 'Critical' })], generatedAtLabel: LABEL });
    expect(model!.roadmap[0].phase).toMatch(/kritisch/i);
    expect(model!.roadmap[0].items[0]).toContain('Art. 5');
  });
});
