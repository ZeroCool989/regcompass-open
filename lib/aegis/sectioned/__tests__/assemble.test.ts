import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleReport, maybeGlueIntro } from '../assemble';
import { ADVISORY_SECTION_NOTE_DE, DEGRADED_SECTION_NOTE_DE } from '../../statusLabels';
import type { SectionRow } from '../job-store';

function row(partial: Partial<SectionRow> & { index: number; title: string }): SectionRow {
  return {
    id: `s-${partial.index}`,
    jobId: 'job-1',
    scopeJson: { grounded: true },
    status: 'done',
    contentMd: null,
    digestJson: null,
    citationsJson: null,
    verifyJson: null,
    firstPassOk: true,
    ...partial,
  };
}

const DUP_PARAGRAPH =
  'Dieser lange Absatz beschreibt die vollständigen Anforderungen an das IKT-Risikomanagement einschließlich Identifikation, Bewertung, Überwachung und Steuerung aller kritischen Funktionen sowie der zugehörigen Informationswerte und Drittdienstleisterbeziehungen im gesamten Lebenszyklus der Systeme.';

describe('assembleReport — deterministic assembler (PR 2)', () => {
  it('orders by index, prefixes plan titles, aggregates citations uniquely', () => {
    const report = assembleReport([
      row({ index: 1, title: 'Zwei', contentMd: 'Inhalt B. [R-DORA-002]', citationsJson: ['[R-DORA-002]'] }),
      row({ index: 0, title: 'Eins', contentMd: 'Inhalt A. [R-DORA-001]', citationsJson: ['[R-DORA-001]', '[R-DORA-002]'] }),
    ]);
    expect(report.text.indexOf('## Eins')).toBeLessThan(report.text.indexOf('## Zwei'));
    expect(report.citations).toEqual(['[R-DORA-001]', '[R-DORA-002]']);
  });

  it('demotes section-internal ## headings below the section level', () => {
    const report = assembleReport([
      row({ index: 0, title: 'Eins', contentMd: '## Unterthema\n\nText.' }),
    ]);
    expect(report.text).toContain('### Unterthema');
    expect(report.text.match(/^## /gm)).toHaveLength(1); // only the section title
  });

  it('drops a verbatim paragraph an earlier section already shipped', () => {
    const report = assembleReport([
      row({ index: 0, title: 'Eins', contentMd: `${DUP_PARAGRAPH}\n\nEigener Inhalt A.` }),
      row({ index: 1, title: 'Zwei', contentMd: `${DUP_PARAGRAPH}\n\nEigener Inhalt B.` }),
    ]);
    expect(report.dedupedBlocks).toBe(1);
    expect(report.text.match(new RegExp(DUP_PARAGRAPH.slice(0, 60), 'g'))).toHaveLength(1);
    expect(report.text).toContain('Eigener Inhalt B.');
  });

  it('labels advisory (grounded=false) and degraded sections honestly', () => {
    const report = assembleReport([
      row({ index: 0, title: 'Beratung', contentMd: 'Empfehlung.', scopeJson: { grounded: false } }),
      row({ index: 1, title: 'Kaputt', contentMd: 'Inhalt.', status: 'degraded' }),
    ]);
    expect(report.text).toContain(ADVISORY_SECTION_NOTE_DE);
    expect(report.text).toContain(DEGRADED_SECTION_NOTE_DE);
    expect(report.degradedSections).toBe(1);
  });

  it('skips sections without content (pending/stale rows)', () => {
    const report = assembleReport([
      row({ index: 0, title: 'Eins', contentMd: 'Inhalt.' }),
      row({ index: 1, title: 'Leer', contentMd: null, status: 'pending' }),
    ]);
    expect(report.text).not.toContain('## Leer');
  });
});

describe('maybeGlueIntro — optional additive glue pass', () => {
  afterEach(() => {
    delete process.env.AEGIS_GLUE_PASS_ENABLED;
  });

  it('is a no-op when the flag is off (default)', async () => {
    const call = vi.fn();
    const report = { text: 'REPORT', citations: [], dedupedBlocks: 0, degradedSections: 0 };
    expect(await maybeGlueIntro(report, ['Eins'], undefined, undefined, call as never)).toBe('REPORT');
    expect(call).not.toHaveBeenCalled();
  });

  it('prepends the intro when enabled, and never touches section text', async () => {
    process.env.AEGIS_GLUE_PASS_ENABLED = '1';
    const call = vi.fn().mockResolvedValue({ text: 'Einleitung.', usage: { input_tokens: 1, output_tokens: 1 } });
    const report = { text: 'REPORT', citations: [], dedupedBlocks: 0, degradedSections: 0 };
    expect(await maybeGlueIntro(report, ['Eins'], undefined, undefined, call as never)).toBe('Einleitung.\n\nREPORT');
  });

  it('fails open: glue transport error yields the untouched report', async () => {
    process.env.AEGIS_GLUE_PASS_ENABLED = '1';
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    const report = { text: 'REPORT', citations: [], dedupedBlocks: 0, degradedSections: 0 };
    expect(await maybeGlueIntro(report, ['Eins'], undefined, undefined, call as never)).toBe('REPORT');
  });
});
