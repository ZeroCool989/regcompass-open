import { describe, expect, it } from 'vitest';
import { verifySection } from '../section-verify';

const GROUNDED_BASE = {
  grounded: true,
  allowedIds: new Set(['R-DORA-001']),
  toolsCalled: 2,
  toolsCalledNames: ['search_kb', 'get_requirements'],
  language: 'de' as const,
};

describe('verifySection — grounded profile (F8: verifyResponse unchanged)', () => {
  it('passes a cited German answer whose IDs were tool-retrieved', () => {
    const { verify: result } = verifySection({
      ...GROUNDED_BASE,
      text: 'Die Anforderung verlangt ein IKT-Risikomanagement [R-DORA-001]. Dies ist eine gesetzliche Pflicht und die Institute müssen die Vorgaben umsetzen.',
    });
    expect(result.ok).toBe(true);
  });

  it('fails citation coverage for an uncited regulatory claim', () => {
    const { verify: result } = verifySection({
      ...GROUNDED_BASE,
      text: 'Art. 5 DORA verlangt ein umfassendes IKT-Risikomanagement der Geschäftsleitung ohne jede Ausnahme für kleine Institute.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('citation_coverage');
  });
});

describe('verifySection — relaxed profile for grounded=false (F8)', () => {
  const RELAXED = {
    grounded: false,
    allowedIds: new Set<string>(),
    toolsCalled: 0,
    toolsCalledNames: [] as string[],
    language: 'de' as const,
  };

  it('accepts advisory content without citations (citation checks skipped)', () => {
    const { verify: result } = verifySection({
      ...RELAXED,
      text: 'Für das Betriebsmodell empfehlen wir eine dedizierte Governance-Struktur und die klare Zuordnung der Verantwortlichkeiten in der Organisation.',
    });
    expect(result.ok).toBe(true);
  });

  it('still fails an empty answer', () => {
    const { verify: result } = verifySection({ ...RELAXED, text: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('non_empty_response');
  });

  it('still fails a language mismatch', () => {
    const { verify: result } = verifySection({
      ...RELAXED,
      text: 'The recommended approach is to establish a dedicated governance structure with clearly assigned responsibilities and regular reviews of the operating model across the organisation.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('language_consistency');
  });
});

describe('verifySection — KNOWN_EXTERNAL_STANDARDS allowlist (F8, PR 2)', () => {
  it('reports an ISO/IEC-form hit as externalRefs even when verify passes outright', () => {
    // "ISO/IEC 27001" is invisible to REGULATION_MENTION — the footnote must
    // not depend on that regex accident (F8: every hit is marked).
    const { verify, externalRefs } = verifySection({
      ...GROUNDED_BASE,
      text: 'Das IKT-Risikomanagement ist verpflichtend [R-DORA-001]. Ergänzend empfiehlt sich eine Zertifizierung nach ISO/IEC 27001 für das ISMS der Bank.',
    });
    expect(verify.ok).toBe(true);
    expect(externalRefs).toEqual(['ISO/IEC 27001']);
  });

  it('excuses a flagged designator (ISO 27001:2022) as a warned pass', () => {
    const { verify, externalRefs } = verifySection({
      ...GROUNDED_BASE,
      text: 'Die Pflicht besteht [R-DORA-001]. Eine Zertifizierung nach ISO 27001:2022 kann die Umsetzung stützen.',
    });
    expect(verify.ok).toBe(true);
    expect(externalRefs).toEqual(['ISO 27001']);
    if (verify.ok) {
      expect(verify.checks.no_hallucinated_regulations).toBe('warn');
      expect(verify.warnings?.some((w) => w.reason.includes('ISO 27001'))).toBe(true);
    }
  });

  it('does NOT excuse an invented standard — real failure survives', () => {
    const { verify, externalRefs } = verifySection({
      ...GROUNDED_BASE,
      text: 'Die Pflicht besteht [R-DORA-001]. Zusätzlich verlangt die ISO 99999 eine jährliche Meldung.',
    });
    expect(verify.ok).toBe(false);
    expect(externalRefs).toEqual([]);
    if (!verify.ok) expect(verify.failed).toBe('no_hallucinated_regulations');
  });

  it('does not let the allowlist mask an unrelated failure in the same text', () => {
    // Language mismatch stays fatal even though ISO/IEC 27001 is allowlisted.
    const { verify } = verifySection({
      grounded: false,
      allowedIds: new Set<string>(),
      toolsCalled: 0,
      toolsCalledNames: [],
      language: 'de',
      text: 'The organisation should pursue an ISO/IEC 27001 certification to demonstrate a mature information security management system across all business units.',
    });
    expect(verify.ok).toBe(false);
  });
});
