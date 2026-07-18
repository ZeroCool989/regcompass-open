import { describe, it, expect, afterEach, vi } from 'vitest';
import { KB } from '@/lib/kb';
import {
  assessApplicability,
  assessCoverage,
  extractEvidence,
  getConfidenceThreshold,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type Evidence,
} from '../coverage';
import { buildGapFinding, dedupeFindings } from '../gap-finding';

const META_CATEGORIES = [
  'penalties',
  'enforcement',
  'definitions',
  'scope',
  'market-surveillance',
  'cooperation',
  'transitional-provisions',
  'application-timeline',
];
const metaReq = KB.requirements.find((r) => META_CATEGORIES.includes(r.category))!;
const coreReq = KB.requirements.find(
  (r) => r.category === 'risk-management' && r.relevanceForFinancialSector !== 'low',
)!;

function evidence(partial: Partial<Evidence>): Evidence {
  return {
    positives: [],
    section: '',
    ratio: 0,
    matchedKeywords: 0,
    totalKeywords: 10,
    ...partial,
  };
}

describe('coverage engine — applicability (Step 1)', () => {
  it('suppresses meta-regulatory requirements with a reason', () => {
    const a = assessApplicability(metaReq);
    expect(a.applicable).toBe(false);
    expect(a.reason.length).toBeGreaterThan(0);
  });

  it('marks a core financial-entity obligation applicable', () => {
    expect(assessApplicability(coreReq).applicable).toBe(true);
  });

  it('suppresses authority-only obligations', () => {
    const authReq = KB.requirements.find(
      (r) => r.audience.length > 0 && r.audience.every((x) => x === 'authority'),
    );
    if (authReq) expect(assessApplicability(authReq).applicable).toBe(false);
  });
});

describe('coverage engine — evidence (Step 3)', () => {
  it('extracts positive sentences when the topic is present', () => {
    const title = coreReq.titleDe ?? coreReq.title;
    const ev = extractEvidence(
      `Abschnitt 4.\n${title} wird im Unternehmen umgesetzt und laufend überwacht.`,
      coreReq,
    );
    expect(ev.positives.length).toBeGreaterThan(0);
    expect(ev.negative).toBeUndefined();
  });

  it('returns "No relevant evidence found." when the topic is absent', () => {
    const ev = extractEvidence('Völlig anderer Inhalt ohne thematischen Bezug. Nichts Relevantes.', coreReq);
    expect(ev.positives.length).toBe(0);
    expect(ev.negative).toBe('No relevant evidence found.');
  });
});

describe('coverage engine — coverage + reasoning (Step 2 + 6)', () => {
  it('classifies covered when most concepts are present', () => {
    const cov = assessCoverage(coreReq, evidence({ positives: ['s'], ratio: 0.9, matchedKeywords: 9 }));
    expect(cov.status).toBe('covered');
    expect(cov.reason.length).toBeGreaterThan(0);
  });

  it('classifies partial (above threshold) with an explanatory reason', () => {
    const cov = assessCoverage(coreReq, evidence({ positives: ['s'], ratio: 0.3, matchedKeywords: 3 }));
    expect(cov.status).toBe('partial');
    expect(cov.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(cov.reason).toContain('gemäß'); // explains WHY against the article
  });

  it('classifies missing with LOW confidence when evidence is incidental', () => {
    const cov = assessCoverage(
      coreReq,
      evidence({ positives: [], negative: 'No relevant evidence found.', ratio: 0.05 }),
    );
    expect(cov.status).toBe('missing');
    expect(cov.confidence).toBeLessThan(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('does not promote single-keyword incidental overlap to a partial gap', () => {
    const cov = assessCoverage(coreReq, evidence({ positives: ['s'], ratio: 0.2, matchedKeywords: 1 }));
    expect(cov.status).toBe('missing'); // < MIN_PARTIAL_KEYWORDS
  });
});

describe('coverage engine — threshold (Step 4) + dedupe (Step 5)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('confidence threshold defaults to 0.70', () => {
    expect(getConfidenceThreshold()).toBe(0.7);
  });

  it('confidence threshold is env-configurable', () => {
    vi.stubEnv('AEGIS_GAP_CONFIDENCE_THRESHOLD', '0.85');
    expect(getConfidenceThreshold()).toBe(0.85);
  });

  it('dedupeFindings collapses duplicate requirement ids, keeping highest confidence', () => {
    const mk = (confidence: number) =>
      buildGapFinding({ req: coreReq, status: 'partial', confidence, reason: 'r', policyExcerpt: 'x' });
    const out = dedupeFindings([mk(0.72), mk(0.88), mk(0.8)]);
    expect(out.length).toBe(1);
    expect(out[0].confidence).toBe(0.88);
  });
});
