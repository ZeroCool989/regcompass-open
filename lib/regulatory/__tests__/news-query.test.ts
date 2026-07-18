import { describe, it, expect } from 'vitest';
import {
  regulationNewsTerms,
  newsTermsForRegulations,
  matchesTerms,
  selectOutlook,
} from '../news-query';

type Row = {
  title: string;
  summary: string;
  relevance: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: Date | null;
  jurisdiction: string;
  tags: string[];
  createdAt: Date;
};

const row = (over: Partial<Row> = {}): Row => ({
  title: 'BaFin-Rundschreiben zu DORA',
  summary: 'Zusammenfassung.',
  relevance: 'Relevant für Banken.',
  sourceName: 'BaFin',
  sourceUrl: 'https://bafin.de/x',
  publishedAt: new Date('2026-06-01'),
  jurisdiction: 'DE',
  tags: ['DORA', 'IT Compliance'],
  createdAt: new Date('2026-06-01'),
  ...over,
});

describe('regulationNewsTerms', () => {
  it('maps display names AND KB enums to the same radar terms', () => {
    expect(regulationNewsTerms('DORA')).toEqual(['dora']);
    expect(regulationNewsTerms('EU AI Act')).toEqual(['ai act', 'ki-verordnung', 'ki verordnung']);
    expect(regulationNewsTerms('EU_AI_ACT')).toEqual(['ai act', 'ki-verordnung', 'ki verordnung']);
    expect(regulationNewsTerms('GDPR')).toContain('datenschutz');
    expect(regulationNewsTerms('NIS2')).toEqual(['nis2', 'nis 2']);
  });

  it('falls back to the normalised name + first token for unmapped regulations', () => {
    expect(regulationNewsTerms('MaRisk')).toEqual(['marisk']);
    expect(regulationNewsTerms('FINMA 08_2024')).toContain('finma 08 2024');
    expect(regulationNewsTerms('FINMA 08_2024')).toContain('finma');
  });

  it('newsTermsForRegulations unions the terms (deduped)', () => {
    const terms = newsTermsForRegulations(['DORA', 'EU AI Act']);
    expect(terms).toContain('dora');
    expect(terms).toContain('ai act');
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('matchesTerms (feed parity — case-insensitive substring on tags)', () => {
  it('matches when any tag contains any term', () => {
    expect(matchesTerms(['DORA', 'IT Compliance'], ['dora'])).toBe(true);
    expect(matchesTerms(['AI Act'], ['ai act'])).toBe(true);
    expect(matchesTerms(['NIS2-Umsetzung'], ['nis2'])).toBe(true); // substring
  });
  it('does not match unrelated tags, and never matches with no terms', () => {
    expect(matchesTerms(['Datenschutz'], ['dora'])).toBe(false);
    expect(matchesTerms(['DORA'], [])).toBe(false);
  });
});

describe('selectOutlook', () => {
  const NOW = new Date('2026-06-30');

  it('returns [] when no regulations are supplied (covered-only scope)', () => {
    expect(selectOutlook([row()], { regulations: [], now: NOW })).toEqual([]);
  });

  it('keeps only items matching the covered regulations', () => {
    const rows = [
      row({ title: 'DORA item', tags: ['DORA'] }),
      row({ title: 'Datenschutz item', tags: ['Datenschutz'] }),
    ];
    const out = selectOutlook(rows, { regulations: ['DORA'], now: NOW });
    expect(out.map((o) => o.title)).toEqual(['DORA item']);
  });

  it('drops items older than the sinceDays window', () => {
    const rows = [
      row({ title: 'recent', tags: ['DORA'], publishedAt: new Date('2026-06-20') }),
      row({ title: 'stale', tags: ['DORA'], publishedAt: new Date('2025-01-01') }),
    ];
    const out = selectOutlook(rows, { regulations: ['DORA'], sinceDays: 180, now: NOW });
    expect(out.map((o) => o.title)).toEqual(['recent']);
  });

  it('uses createdAt when publishedAt is null', () => {
    const out = selectOutlook(
      [row({ title: 'no-date', tags: ['DORA'], publishedAt: null, createdAt: new Date('2026-06-25') })],
      { regulations: ['DORA'], now: NOW },
    );
    expect(out).toHaveLength(1);
    expect(out[0].publishedAt).toBeNull();
  });

  it('sorts newest-first and caps at the limit', () => {
    const rows = [
      row({ title: 'A', tags: ['DORA'], publishedAt: new Date('2026-06-01') }),
      row({ title: 'B', tags: ['DORA'], publishedAt: new Date('2026-06-20') }),
      row({ title: 'C', tags: ['DORA'], publishedAt: new Date('2026-06-10') }),
    ];
    const out = selectOutlook(rows, { regulations: ['DORA'], limit: 2, now: NOW });
    expect(out.map((o) => o.title)).toEqual(['B', 'C']);
  });

  it('echoes the stored fields verbatim (anti-hallucination — no invented content)', () => {
    const r = row({ title: 'Echo', tags: ['DORA'], relevance: 'X', sourceUrl: 'https://src/1' });
    const [o] = selectOutlook([r], { regulations: ['DORA'], now: NOW });
    expect(o).toMatchObject({ title: 'Echo', relevance: 'X', sourceUrl: 'https://src/1', sourceName: 'BaFin' });
  });
});
