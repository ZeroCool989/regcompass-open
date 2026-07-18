import { describe, expect, it } from 'vitest';
import { KB } from '@/lib/kb';
import {
  buildGapFinding,
  deriveSeverity,
  buildRecommendation,
  buildRiskImpact,
  validateGapFinding,
  isUsableExcerpt,
  NO_POLICY_EXCERPT,
  NO_POLICY_EVIDENCE,
  type GapFinding,
} from '../gap-finding';

// A requirement that actually has controls (for the recommendation builder).
const reqWithControls = KB.requirements.find((r) => r.controls.length > 0)!;
const anyReq = KB.requirements[0];

describe('gap-finding domain model', () => {
  it('buildGapFinding populates every required field', () => {
    const f = buildGapFinding({
      req: reqWithControls,
      status: 'missing',
      confidence: 0.5,
      reason: 'Kein Nachweis im Dokument gefunden.',
    });
    expect(f.regulation.length).toBeGreaterThan(0);
    expect(f.article.length).toBeGreaterThan(0);
    expect(f.requirementId).toBe(reqWithControls.id);
    expect(f.requirementArea.length).toBeGreaterThan(0);
    expect(f.policyExcerpt.length).toBeGreaterThan(0); // absence note for missing
    expect(f.gapDescription.length).toBeGreaterThan(0);
    expect(f.riskImpact.length).toBeGreaterThan(0);
    expect(['Low', 'Medium', 'High', 'Critical']).toContain(f.severity);
    expect(f.recommendation.length).toBeGreaterThanOrEqual(25);
    expect(f.evidence.length).toBeGreaterThan(0);
    expect(f.citations).toContain(reqWithControls.id);
    expect(f.confidence).toBeGreaterThanOrEqual(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
  });

  it('recommendation is specific and never a placeholder', () => {
    const rec = buildRecommendation(reqWithControls);
    expect(rec).not.toMatch(/^implement controls?/i);
    expect(rec.length).toBeGreaterThan(25);
    // Anchored to the actual regulation + article reference of the requirement.
    expect(rec).toContain('gemäss');
    expect(rec).toContain(reqWithControls.article);
  });

  it('riskImpact is a narrative, not just the severity word', () => {
    const risk = buildRiskImpact(reqWithControls);
    expect(risk.length).toBeGreaterThan(30);
    expect(['Low', 'Medium', 'High', 'Critical']).not.toContain(risk);
  });

  it('deriveSeverity maps relevance/binding to a capitalised severity', () => {
    expect(['Low', 'Medium', 'High', 'Critical']).toContain(deriveSeverity(anyReq));
  });

  describe('excerpt quality gate', () => {
    const bad = [
      'Document Classification:',
      'Monitoring',
      'ensures second-line independence',
      '3.2 17 Mar 2026 CISO Updated definitions',
      'Inhaltsverzeichnis .......... 4',
      'Confidential — page 2',
    ];
    for (const s of bad) {
      it(`rejects junk excerpt: "${s.slice(0, 30)}"`, () => {
        expect(isUsableExcerpt(s)).toBe(false);
      });
    }

    it('accepts a substantive policy sentence', () => {
      expect(
        isUsableExcerpt('Die Bank unterhält ein dokumentiertes IKT-Risikomanagement und überprüft es jährlich.'),
      ).toBe(true);
    });

    it('buildGapFinding replaces a junk excerpt with the standard absence text', () => {
      const f = buildGapFinding({
        req: reqWithControls,
        status: 'partial',
        confidence: 0.8,
        reason: 'r',
        policyExcerpt: 'Document Classification:',
      });
      expect(f.policyExcerpt).toBe(NO_POLICY_EXCERPT);
      expect(f.evidence).toBe(NO_POLICY_EVIDENCE);
    });

    it('buildGapFinding keeps a good excerpt', () => {
      const good = 'Die Bank unterhält ein dokumentiertes IKT-Risikomanagement und überprüft es jährlich.';
      const f = buildGapFinding({
        req: reqWithControls,
        status: 'partial',
        confidence: 0.8,
        reason: 'r',
        policyExcerpt: good,
      });
      expect(f.policyExcerpt).toContain('IKT-Risikomanagement');
    });
  });

  it('covered findings carry the policy excerpt that was passed in', () => {
    const f = buildGapFinding({
      req: anyReq,
      status: 'covered',
      confidence: 0.9,
      reason: 'Umfassend adressiert.',
      policyExcerpt: 'Die Richtlinie regelt dieses Thema ausführlich in Abschnitt 3.',
      policySection: 'Abschnitt 3',
    });
    expect(f.policyExcerpt).toContain('Richtlinie');
    expect(f.policySection).toBe('Abschnitt 3');
    expect(f.reason).toBe('Umfassend adressiert.');
  });

  describe('validateGapFinding', () => {
    const base = (): GapFinding =>
      buildGapFinding({
        req: reqWithControls,
        status: 'missing',
        confidence: 0.5,
        reason: 'Kein Nachweis gefunden.',
        id: 'GAP-001',
      });

    it('accepts a complete finding', () => {
      expect(validateGapFinding(base()).ok).toBe(true);
    });

    it('rejects a missing article', () => {
      const res = validateGapFinding({ ...base(), article: '' });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing article');
    });

    it('rejects a missing severity', () => {
      const res = validateGapFinding({ ...base(), severity: '' as unknown as GapFinding['severity'] });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing/invalid severity');
    });

    it('rejects an empty excerpt', () => {
      const res = validateGapFinding({ ...base(), policyExcerpt: '   ' });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing policyExcerpt');
    });

    it('rejects a placeholder recommendation', () => {
      const res = validateGapFinding({ ...base(), recommendation: 'Implement controls for X' });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing/placeholder recommendation');
    });

    it('rejects a missing status', () => {
      const res = validateGapFinding({ ...base(), status: '' as unknown as GapFinding['status'] });
      expect(res.ok).toBe(false);
      expect(res.errors).toContain('missing/invalid status');
    });
  });
});
