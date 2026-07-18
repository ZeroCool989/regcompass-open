import { describe, it, expect } from 'vitest';
import { buildMarkdown, type ProvenanceMeta } from '@/lib/regulatory/ingest';
import { machineTranslatedNote, langLabel } from '../translate-regulatory';

const meta: ProvenanceMeta = {
  title: 'BaFin Rundschreiben (DE)',
  sourceName: 'BaFin',
  sourceUrl: 'https://www.bafin.de/x',
  documentUrl: 'https://www.bafin.de/x.pdf',
  regulation: 'DORA',
  jurisdiction: 'DE',
};

describe('langLabel', () => {
  it('maps known codes to German labels and falls back to the code', () => {
    expect(langLabel('ES')).toBe('Spanisch');
    expect(langLabel('de')).toBe('Deutsch');
    expect(langLabel('xx')).toBe('XX');
    expect(langLabel(null)).toBe('unbekannt');
  });
});

describe('machine-translated markdown header', () => {
  it('renders the machine-translated provenance note + language line', () => {
    const note = machineTranslatedNote('ES', 'DE');
    const md = buildMarkdown(meta, 'Übersetzter Korpus-Text.', note, [
      `**Übersetzung:** ${langLabel('ES')} → ${langLabel('DE')} · DeepL`,
    ]);
    expect(md).toContain('# BaFin Rundschreiben (DE)');
    expect(md).toContain('Maschinell übersetzt mit DeepL');
    expect(md).toContain('Spanisch → Deutsch');
    expect(md).toContain('nicht Teil der kuratierten Wissensbasis');
    expect(md).toContain('Übersetzter Korpus-Text.');
  });

  it('still defaults to the ingested note when none is given', () => {
    const md = buildMarkdown(meta, 'Body.');
    expect(md).toContain('Extern eingespeist');
  });
});
