import { describe, it, expect } from 'vitest';
import { rankPassages, splitIntoPassages, tokenize } from '../tools/_passages';

const para = (s: string) => s.padEnd(60, ' .');

describe('splitIntoPassages', () => {
  it('splits on blank lines and drops sub-threshold fragments', () => {
    const text = `${para('Artikel 1 IKT-Risikomanagement')}\n\nklein\n\n${para('Artikel 2 Meldepflichten')}`;
    const out = splitIntoPassages(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Artikel 1');
  });

  it('tolerates CRLF paragraph breaks', () => {
    const text = `${para('Erster Absatz Resilienz')}\r\n\r\n${para('Zweiter Absatz Vorfall')}`;
    expect(splitIntoPassages(text)).toHaveLength(2);
  });
});

describe('tokenize', () => {
  it('lowercases, splits, and keeps digits', () => {
    expect(tokenize('DORA Art 17')).toEqual(['dora', 'art', '17']);
  });
});

describe('rankPassages', () => {
  const text = [
    para('Meldung von schwerwiegenden IKT-Vorfällen an die Aufsicht innerhalb der Frist'),
    para('Allgemeine Bestimmungen ohne thematischen Bezug zum Thema hier'),
    para('IKT-Vorfälle und deren Klassifizierung sowie Vorfälle melden melden'),
  ].join('\n\n');

  it('ranks passages with more token hits first', () => {
    const out = rankPassages(text, 'vorfälle melden', 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].score).toBeGreaterThanOrEqual(out[out.length - 1].score);
    // The third passage mentions "Vorfälle"/"melden" most often → top.
    expect(out[0].passage).toContain('Klassifizierung');
  });

  it('respects the cap', () => {
    expect(rankPassages(text, 'ikt', 1)).toHaveLength(1);
  });

  it('returns [] for an empty query', () => {
    expect(rankPassages(text, '   ', 5)).toEqual([]);
  });
});
