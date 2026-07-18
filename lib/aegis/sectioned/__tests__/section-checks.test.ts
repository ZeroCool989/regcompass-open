import { describe, expect, it } from 'vitest';
import {
  checkContradiction,
  checkDuplication,
  checkRepairFeedback,
  checkScope,
  hasBlockingFindings,
  runSectionChecks,
  trigramOverlap,
  trigramSet,
} from '../section-checks';
import type { PlanSection, PlanVocab } from '../plan';

const SECTION: PlanSection = {
  title: 'IKT-Risikomanagement',
  covers: ['risikomanagement'],
  coversNot: ['Vorfallmeldung'],
  kbDomains: ['DORA'],
  grounded: true,
  outputShape: 'prose',
  estTokens: 800,
};

const VOCAB: PlanVocab = {
  entities: ['Musterbank AG'],
  jurisdictions: ['EU'],
  terminology: ['Auslagerung, nicht Outsourcing'],
  citationStyle: '[R-...] inline',
};

const LONG_A =
  'Die Institute müssen ein umfassendes IKT-Risikomanagement etablieren und dabei sämtliche kritischen Funktionen und Informationswerte fortlaufend identifizieren, bewerten und überwachen, einschließlich der Abhängigkeiten von IKT-Drittdienstleistern und der zugehörigen Kontrollen im gesamten Lebenszyklus. [R-DORA-005]';

describe('trigram duplication', () => {
  it('flags a section that repeats a prior section nearly verbatim', () => {
    const priors = [{ index: 0, title: 'A', trigrams: trigramSet(LONG_A) }];
    const findings = checkDuplication(`${LONG_A} Ergänzender Satz dazu.`, priors, 0.35);
    expect(findings).toHaveLength(1);
    expect(findings[0].withIndex).toBe(0);
    expect(findings[0].ratio).toBeGreaterThan(0.8);
  });

  it('does not flag genuinely different content', () => {
    const priors = [{ index: 0, title: 'A', trigrams: trigramSet(LONG_A) }];
    const findings = checkDuplication(
      'Meldewesen für schwerwiegende Vorfälle folgt einem völlig anderen Ablauf mit eigenen Fristen und Formaten gegenüber der Aufsicht.',
      priors,
      0.35,
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores repeated [R-...] citations when measuring overlap', () => {
    const a = 'Kurzer Satz. [R-DORA-001] [R-DORA-002] [R-DORA-003]';
    const b = 'Ganz anderer Inhalt hier. [R-DORA-001] [R-DORA-002] [R-DORA-003]';
    expect(trigramOverlap(trigramSet(a), trigramSet(b))).toBeLessThan(0.35);
  });
});

describe('scope adherence', () => {
  it('flags a coversNot topic that got its own heading', () => {
    const text = `Inhalt.\n\n### Vorfallmeldung im Detail\n\nMehr Inhalt.`;
    expect(checkScope(text, SECTION)).toEqual([
      { keyword: 'Vorfallmeldung', kind: 'heading' },
    ]);
  });

  it('flags repeated body mentions (>= 3) of an out-of-scope topic', () => {
    const text =
      'Die Vorfallmeldung ist wichtig. Ohne Vorfallmeldung geht nichts. Die Vorfallmeldung hat Fristen.';
    expect(checkScope(text, SECTION)).toEqual([
      { keyword: 'Vorfallmeldung', kind: 'repeated' },
    ]);
  });

  it('accepts a single cross-reference to the owning section', () => {
    const text = 'Details zur Vorfallmeldung behandelt Abschnitt 3.';
    expect(checkScope(text, SECTION)).toEqual([]);
  });
});

describe('contradiction heuristic', () => {
  it('flags an obligation/optional clash on a shared vocab term across sections', () => {
    const current =
      'Die Auslagerung kritischer Funktionen ist für die Musterbank AG verpflichtend zu dokumentieren und muss vor Vertragsschluss angezeigt werden.';
    const priors = [
      {
        index: 0,
        title: 'Grundlagen',
        text: 'Die Dokumentation der Auslagerung ist optional und kann nach eigenem Ermessen der Musterbank AG erfolgen.',
      },
    ];
    const findings = checkContradiction(current, 1, priors, VOCAB);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].withIndex).toBe(0);
  });

  it('stays silent when modality agrees', () => {
    const current = 'Die Auslagerung muss dokumentiert werden.';
    const priors = [
      { index: 0, title: 'A', text: 'Für die Auslagerung ist die Dokumentation verpflichtend.' },
    ];
    expect(checkContradiction(current, 1, priors, VOCAB)).toEqual([]);
  });
});

describe('aggregate + feedback', () => {
  it('blocking = duplication or scope; contradictions are audit-only', () => {
    expect(
      hasBlockingFindings({ duplication: [], scope: [], contradiction: [{ term: 't', withIndex: 0, withTitle: 'A', current: 'x', prior: 'y' }] }),
    ).toBe(false);
    expect(
      hasBlockingFindings({ duplication: [{ withIndex: 0, withTitle: 'A', ratio: 0.5 }], scope: [], contradiction: [] }),
    ).toBe(true);
  });

  it('produces German repair feedback naming the offending sections/topics', () => {
    const feedback = checkRepairFeedback({
      duplication: [{ withIndex: 0, withTitle: 'Grundlagen', ratio: 0.62 }],
      scope: [{ keyword: 'Vorfallmeldung', kind: 'heading' }],
      contradiction: [],
    });
    expect(feedback).toContain('Grundlagen');
    expect(feedback).toContain('62 %');
    expect(feedback).toContain('Vorfallmeldung');
  });

  it('runSectionChecks wires all three checks together', () => {
    const findings = runSectionChecks({
      text: LONG_A,
      section: SECTION,
      sectionIndex: 1,
      priors: [{ index: 0, title: 'A', text: LONG_A }],
      vocab: VOCAB,
    });
    expect(findings.duplication).toHaveLength(1);
    expect(findings.scope).toEqual([]);
  });
});
