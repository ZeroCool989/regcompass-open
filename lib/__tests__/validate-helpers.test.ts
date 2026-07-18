import { describe, expect, it } from 'vitest';
import { checkArticleRefs, controlFingerprint, extractArticleRefs } from '@/lib/kb/validate-helpers';

describe('extractArticleRefs', () => {
  it('parses simple articles and ranges at their endpoints', () => {
    const labels = extractArticleRefs('Art. 34-35').map(r => r.label);
    expect(labels).toEqual(['Art. 34', 'Art. 35']);
  });

  it('parses combined references (Art. 4 + Art. 7)', () => {
    expect(extractArticleRefs('Art. 4 + Art. 7').map(r => r.label)).toEqual(['Art. 4', 'Art. 7']);
  });

  it('parses paragraphs, MaRisk modules, Tz., Rz., sections, clauses, annexes', () => {
    expect(extractArticleRefs('§ 22 + § 27 BDSG').map(r => r.kind)).toEqual(['paragraph', 'paragraph']);
    expect(extractArticleRefs('AT 4.3.4 MaRisk')[0]).toMatchObject({ kind: 'at', label: 'AT 4.3.4' });
    expect(extractArticleRefs('Tz. 3.1-3.11 BAIT').map(r => r.label)).toEqual(['Tz. 3.1', 'Tz. 3.11']);
    expect(extractArticleRefs('FINMA RS 2018/3 Rz 32-35').some(r => r.kind === 'rz')).toBe(true);
    expect(extractArticleRefs('Section 5.1 GOVERN')[0].kind).toBe('section');
    expect(extractArticleRefs('Clauses 4-10 + Annex A').map(r => r.kind)).toEqual([
      'clause', 'clause', 'annex',
    ]);
    expect(extractArticleRefs('Anhang III')[0]).toMatchObject({ kind: 'annex', label: 'Annex III' });
  });

  it('treats standard designators as whole-document references (skipped)', () => {
    const refs = extractArticleRefs('ISO/IEC 23894:2023');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('designator');
  });
});

describe('checkArticleRefs', () => {
  it('locates German "Artikel N" spelling for "Art. N" references', () => {
    const source = 'Kapitel II\nArtikel 5\nVerbotene Praktiken im KI-Bereich…';
    const res = checkArticleRefs('Art. 5', source);
    expect(res.missing).toHaveLength(0);
    expect(res.located.map(r => r.label)).toEqual(['Art. 5']);
  });

  it('accepts verbatim en-dash ranges for FINMA Rz references', () => {
    // PDF extraction keeps "32–35" (en-dash) but loses per-paragraph numbers.
    const source = 'Inhalt\n32–35\nGovernance-Anforderungen…';
    const res = checkArticleRefs('Rz 32-35', source);
    expect(res.missing).toHaveLength(0);
  });

  it('reports references that are genuinely absent', () => {
    const res = checkArticleRefs('Art. 999', 'Artikel 1 bis Artikel 113.');
    expect(res.missing.map(r => r.label)).toEqual(['Art. 999']);
  });
});

describe('controlFingerprint', () => {
  const base = {
    action: 'a', description: 'd', priority: 'high', complexity: 'low',
  };
  it('is stable for identical controls and differs on content changes', () => {
    expect(controlFingerprint(base)).toBe(controlFingerprint({ ...base }));
    expect(controlFingerprint(base)).not.toBe(controlFingerprint({ ...base, action: 'b' }));
  });
});
