import { describe, it, expect } from 'vitest';
import {
  newsDedupeKey,
  suggestionDedupeKey,
  dedupeNews,
  dedupeSuggestions,
  normalizeUrl,
} from '../dedupe';
import type { KbSuggestion, NewsItem } from '../types';

const news = (over: Partial<NewsItem> = {}): NewsItem => ({
  title: 'EBA veröffentlicht DORA-RTS',
  summary: 'x'.repeat(20),
  relevance: 'Relevant für Banken.',
  sourceName: 'EBA',
  sourceUrl: 'https://www.eba.europa.eu/news/dora-rts',
  publishedAt: '2026-06-29',
  jurisdiction: 'EU',
  tags: ['DORA'],
  ...over,
});

const sug = (over: Partial<KbSuggestion> = {}): KbSuggestion => ({
  sourceName: 'EBA',
  sourceUrl: 'https://www.eba.europa.eu/news/dora-rts',
  regulation: 'DORA',
  proposedRequirementId: 'R-DORA-031',
  proposedRequirementText: 'x'.repeat(30),
  relevanceForFinancialSector: 'high',
  bindingLevel: 'mandatory',
  rationale: 'Neue verbindliche RTS.',
  ...over,
});

describe('normalizeUrl', () => {
  it('ignores trailing slash, hash and host case', () => {
    expect(normalizeUrl('https://WWW.EBA.europa.eu/news/dora-rts/#sec')).toBe(
      'https://www.eba.europa.eu/news/dora-rts',
    );
  });
});

describe('newsDedupeKey', () => {
  it('is stable for the same url/title/date regardless of url cosmetics', () => {
    expect(newsDedupeKey(news())).toBe(newsDedupeKey(news({ sourceUrl: 'https://www.eba.europa.eu/news/dora-rts/' })));
  });
  it('differs when the title or date differs', () => {
    expect(newsDedupeKey(news())).not.toBe(newsDedupeKey(news({ title: 'Andere Meldung' })));
    expect(newsDedupeKey(news())).not.toBe(newsDedupeKey(news({ publishedAt: '2026-06-28' })));
  });
});

describe('suggestionDedupeKey', () => {
  it('keys on the proposed requirement id when present', () => {
    expect(suggestionDedupeKey(sug())).toBe(suggestionDedupeKey(sug({ proposedRequirementText: 'völlig anderer Text hier' })));
  });
  it('falls back to a text slug when no id', () => {
    const a = suggestionDedupeKey(sug({ proposedRequirementId: undefined, proposedRequirementText: 'Backup-Pflicht definieren xx' }));
    const b = suggestionDedupeKey(sug({ proposedRequirementId: undefined, proposedRequirementText: 'Etwas ganz anderes hier yy' }));
    expect(a).not.toBe(b);
  });
});

describe('within-batch dedup', () => {
  it('drops duplicate news (keeps first)', () => {
    const out = dedupeNews([news(), news({ sourceUrl: 'https://www.eba.europa.eu/news/dora-rts/' }), news({ title: 'Neu' })]);
    expect(out).toHaveLength(2);
  });
  it('drops duplicate suggestions', () => {
    const out = dedupeSuggestions([sug(), sug({ rationale: 'andere Begründung' }), sug({ proposedRequirementId: 'R-DORA-099' })]);
    expect(out).toHaveLength(2);
  });
});
