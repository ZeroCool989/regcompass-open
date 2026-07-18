import { describe, it, expect } from 'vitest';
import { extractJsonObject, parseResearchResult } from '../research';

const validItem = {
  title: 'BaFin aktualisiert Auslagerungsanzeige',
  summary: 'Die BaFin hat ihre Hinweise zur Auslagerungsanzeige aktualisiert.',
  relevance: 'Betrifft das IKT-Drittparteienmanagement von Banken.',
  sourceName: 'BaFin',
  sourceUrl: 'https://www.bafin.de/news/auslagerung',
  publishedAt: '2026-06-29',
  jurisdiction: 'DE',
  tags: ['DORA', 'Auslagerung'],
};

const validSuggestion = {
  sourceName: 'BaFin',
  sourceUrl: 'https://www.bafin.de/news/auslagerung',
  regulation: 'DORA',
  proposedRequirementId: 'R-DORA-031',
  proposedRequirementText: 'Auslagerungsanzeigen sind fristgerecht bei der Aufsicht einzureichen.',
  relevanceForFinancialSector: 'high',
  bindingLevel: 'mandatory',
  rationale: 'Neue konkretisierte Pflicht aus der Aufsichtsmitteilung.',
};

describe('extractJsonObject', () => {
  it('pulls JSON from a ```json fence', () => {
    expect(extractJsonObject('Hier:\n```json\n{"a":1}\n```\nEnde')).toBe('{"a":1}');
  });
  it('falls back to the outermost braces in prose', () => {
    expect(extractJsonObject('prefix {"a":1} suffix')).toBe('{"a":1}');
  });
});

describe('parseResearchResult — source parsing + KB mapping', () => {
  it('parses valid news + suggestions', () => {
    const out = parseResearchResult(JSON.stringify({ news: [validItem], suggestions: [validSuggestion] }));
    expect(out.news).toHaveLength(1);
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0].relevanceForFinancialSector).toBe('high');
    expect(out.suggestions[0].bindingLevel).toBe('mandatory');
  });

  it('handles a ```json-fenced response', () => {
    const out = parseResearchResult('```json\n' + JSON.stringify({ news: [validItem] }) + '\n```');
    expect(out.news).toHaveLength(1);
  });

  it('returns empty (no fake content) on invalid JSON', () => {
    expect(parseResearchResult('totally not json')).toEqual({ news: [], suggestions: [] });
  });

  it('drops items WITHOUT a real http(s) source URL (anti-hallucination)', () => {
    const out = parseResearchResult(
      JSON.stringify({
        news: [validItem, { ...validItem, sourceUrl: 'not-a-url', title: 'Erfunden' }],
      }),
    );
    expect(out.news).toHaveLength(1);
    expect(out.news[0].title).toBe(validItem.title);
  });

  it('keeps valid items even when a sibling item is malformed', () => {
    const out = parseResearchResult(
      JSON.stringify({
        suggestions: [validSuggestion, { ...validSuggestion, bindingLevel: 'not-a-level' }],
      }),
    );
    expect(out.suggestions).toHaveLength(1);
  });

  it('dedupes within the batch', () => {
    const out = parseResearchResult(JSON.stringify({ news: [validItem, validItem] }));
    expect(out.news).toHaveLength(1);
  });

  it('returns empty for an empty research result (no padding)', () => {
    expect(parseResearchResult(JSON.stringify({ news: [], suggestions: [] }))).toEqual({
      news: [],
      suggestions: [],
    });
  });
});
