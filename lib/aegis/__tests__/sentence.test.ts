import { describe, expect, it } from 'vitest';
import { extractSentences } from '../sentence';

describe('extractSentences', () => {
  it('emits a sentence only once it is closed by punctuation + space', () => {
    const a = extractSentences('Hallo Almir');
    expect(a.sentences).toEqual([]);
    expect(a.rest).toBe('Hallo Almir');

    const b = extractSentences('Hallo Almir. Wie geht');
    expect(b.sentences).toEqual(['Hallo Almir.']);
    expect(b.rest).toBe('Wie geht');
  });

  it('does NOT split a period at the very end of the buffer (may grow)', () => {
    const r = extractSentences('Das ist 3.');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('Das ist 3.');
  });

  it('keeps decimals together ("3.1")', () => {
    const r = extractSentences('Version 3.1 ist da. Ok');
    expect(r.sentences).toEqual(['Version 3.1 ist da.']);
  });

  it('does not split after German abbreviations (z. B., Art.)', () => {
    const r = extractSentences('Das gilt z. B. für Banken. Ende');
    expect(r.sentences).toEqual(['Das gilt z. B. für Banken.']);

    const r2 = extractSentences('Siehe Art. 5 der Verordnung. Mehr');
    expect(r2.sentences).toEqual(['Siehe Art. 5 der Verordnung.']);
  });

  it('does not split English abbreviations (e.g., i.e., Dr.)', () => {
    const r = extractSentences('See e.g. the rule. Next');
    expect(r.sentences).toEqual(['See e.g. the rule.']);

    const r2 = extractSentences('Dr. Müller kommt. Bald');
    expect(r2.sentences).toEqual(['Dr. Müller kommt.']);
  });

  it('does not split inside an unclosed citation, but does after it closes', () => {
    const open = extractSentences('DORA ist ein Regelwerk [R-DORA');
    expect(open.sentences).toEqual([]);

    const closed = extractSentences('DORA ist ein Regelwerk [R-DORA-003]. Banken');
    expect(closed.sentences).toEqual(['DORA ist ein Regelwerk [R-DORA-003].']);
  });

  it('treats newlines / bullet lines as boundaries', () => {
    const r = extractSentences('Punkt eins\nPunkt zwei\n');
    expect(r.sentences).toEqual(['Punkt eins', 'Punkt zwei']);
    expect(r.rest).toBe('');
  });

  it('handles multiple sentences and question/exclamation marks', () => {
    const r = extractSentences('Was ist DORA? Es ist ein EU-Regelwerk! Klar.\n');
    expect(r.sentences).toEqual([
      'Was ist DORA?',
      'Es ist ein EU-Regelwerk!',
      'Klar.',
    ]);
    expect(r.rest).toBe('');
  });

  it('does not split a leading enumeration marker from its item', () => {
    const r = extractSentences('1. Erstelle das Inventar. ');
    expect(r.sentences).toEqual(['1. Erstelle das Inventar.']);

    const multi = extractSentences('1. Erster Schritt.\n2. Zweiter Schritt.\n');
    expect(multi.sentences).toEqual(['1. Erster Schritt.', '2. Zweiter Schritt.']);
  });

  it('still splits a sentence ending in a year (not a list marker)', () => {
    const r = extractSentences('Das war 2020. Heute ist es anders. ');
    expect(r.sentences).toEqual(['Das war 2020.', 'Heute ist es anders.']);
  });

  it('carries an incomplete tail in rest for the next call', () => {
    const first = extractSentences('Erster Satz. Zweiter');
    expect(first.sentences).toEqual(['Erster Satz.']);
    const second = extractSentences(first.rest + ' Satz. Dritter');
    expect(second.sentences).toEqual(['Zweiter Satz.']);
    expect(second.rest).toBe('Dritter');
  });
});
