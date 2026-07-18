import { describe, it, expect } from 'vitest';
import { parseBlocks, parseCriticality } from '../markdown-blocks';

describe('parseBlocks — blockquotes', () => {
  it('parses a `>` block into a neutral quote callout', () => {
    const [block] = parseBlocks('> Eine Randnotiz ohne Warnung.');
    expect(block).toEqual({ type: 'quote', text: 'Eine Randnotiz ohne Warnung.', warn: false });
  });

  it('flags a ⚠️ blockquote as the amber warn variant (e.g. the degradation banner)', () => {
    const [block] = parseBlocks(
      '> ⚠️ **Verifizierung unvollständig:** 2 Aussagen konnten nicht geprüft werden.',
    );
    expect(block.type).toBe('quote');
    if (block.type === 'quote') {
      expect(block.warn).toBe(true);
      expect(block.text).toContain('Verifizierung unvollständig');
      expect(block.text.startsWith('>')).toBe(false); // prefix stripped
    }
  });

  it('joins a multi-line `>` blockquote and strips every prefix', () => {
    const [block] = parseBlocks('> Zeile eins\n> Zeile zwei');
    expect(block).toEqual({ type: 'quote', text: 'Zeile eins\nZeile zwei', warn: false });
  });

  it('does NOT route a `> ⚠️ Hinweis` quote to the legacy law-source warning box', () => {
    const blocks = parseBlocks('> ⚠️ Hinweis: ISO 27001 ist nicht in der KB kuratiert.');
    expect(blocks[0].type).toBe('quote'); // not 'warning'
  });

  it('still renders the explicit "⚠️ Quelle:" law-source note as a warning block', () => {
    const blocks = parseBlocks('⚠️ Quelle: Gesetzestext Art. 5 DORA.');
    expect(blocks[0].type).toBe('warning');
  });
});

describe('parseBlocks — existing block types unaffected', () => {
  it('keeps headings, tables and lists working', () => {
    const md = '# Titel\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- eins\n- zwei';
    const blocks = parseBlocks(md);
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, text: 'Titel' });
    expect(blocks[1].type).toBe('table');
    expect(blocks[2]).toEqual({ type: 'ul', items: ['eins', 'zwei'] });
  });
});

describe('parseCriticality', () => {
  it('maps the traffic-light emoji to a severity + label', () => {
    expect(parseCriticality('🔴 Kritisch')).toEqual({ severity: 'critical', label: 'Kritisch' });
    expect(parseCriticality('🟠 Hoch')).toEqual({ severity: 'high', label: 'Hoch' });
    expect(parseCriticality('🟡 Mittel-Hoch')).toEqual({ severity: 'medium', label: 'Mittel-Hoch' });
    expect(parseCriticality('🟢 Niedrig')).toEqual({ severity: 'low', label: 'Niedrig' });
  });

  it('keeps a trailing qualifier in the label', () => {
    expect(parseCriticality('🔴 Kritisch (CH)')).toEqual({ severity: 'critical', label: 'Kritisch (CH)' });
  });

  it('falls back to the emoji when there is no trailing text', () => {
    expect(parseCriticality('🔴')).toEqual({ severity: 'critical', label: '🔴' });
  });

  it('returns null for ordinary cells', () => {
    expect(parseCriticality('IKT-Drittdienstleister')).toBeNull();
    expect(parseCriticality('EU')).toBeNull();
  });
});
