import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';
import { KB } from '@/lib/kb';
import { improveDocx } from '../export/docx-improve';
import { buildChangeLogDocx } from '../export/changelog';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { fakeDb } from './helpers/fake-db';
import { storeDocument, getDocument } from '../document-store';
import { saveFindings } from '../findings-store';
import { buildGapFinding } from '../gap-finding';
import { executeImproveDocument } from '../tools/improve_document';

const SESSION = 'improve-session';
const CTX = { sessionId: SESSION };

const REQ = KB.requirements.find((r) => r.id === 'R-DORA-024') ?? KB.requirements[0];
const STALE = 'Die jährliche Testpflicht gilt nur für kritische Funktionen.';

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      { children: paragraphs.map((t) => new Paragraph({ children: [new TextRun({ text: t })] })) },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

function finding(id: string) {
  return buildGapFinding({
    req: REQ,
    status: 'missing',
    confidence: 0.9,
    reason: 'test',
    id,
  });
}

describe('improveDocx (surgical OOXML patch)', () => {
  it('replaces text, appends a section, and preserves untouched parts', async () => {
    const original = await makeDocx(['Präambel.', STALE, 'Schluss.']);
    const res = improveDocx(original, [
      { type: 'replaceText', find: STALE, replace: 'KORRIGIERTE AUSSAGE [R-DORA-024]' },
      { type: 'appendSection', heading: 'Regulatorische Ergänzungen (AEGIS)', paragraphs: ['Ergänzung eins.'] },
    ]);
    expect(res.replacements).toBe(1);
    expect(res.appendedParagraphs).toBe(2);
    expect(res.skipped).toHaveLength(0);

    const text = (await mammoth.extractRawText({ buffer: res.buffer })).value;
    expect(text).toContain('KORRIGIERTE AUSSAGE [R-DORA-024]');
    expect(text).not.toContain(STALE);
    expect(text).toContain('Präambel.');
    expect(text).toContain('Schluss.');
    expect(text).toContain('Regulatorische Ergänzungen (AEGIS)');
    expect(text).toContain('Ergänzung eins.');
  });

  it('reports unfindable ops in skipped instead of silently dropping them', async () => {
    const original = await makeDocx(['Nur dieser Satz.']);
    const res = improveDocx(original, [
      { type: 'replaceText', find: 'gibt es nicht', replace: 'egal' },
    ]);
    expect(res.replacements).toBe(0);
    expect(res.skipped).toHaveLength(1);
  });

  it('change-log completeness: every text diff between original and improved appears in the log', async () => {
    const original = await makeDocx(['Absatz A.', STALE, 'Absatz C.']);
    const replace = `${(REQ.summaryDe?.trim() || REQ.summary).slice(0, 80)} [${REQ.id}]`;
    const ops = [{ type: 'replaceText' as const, find: STALE, replace }];
    const res = improveDocx(original, ops);

    const before = (await mammoth.extractRawText({ buffer: original })).value.replace(/\s+/g, ' ');
    const after = (await mammoth.extractRawText({ buffer: res.buffer })).value.replace(/\s+/g, ' ');
    // The only segments allowed to differ are exactly the op's find/replace.
    expect(before).toContain(STALE);
    expect(after).not.toContain(STALE);
    const beforeRest = before.replace(STALE, '‹CHANGE›');
    const afterRest = after.replace(replace.replace(/\s+/g, ' '), '‹CHANGE›');
    expect(beforeRest).toBe(afterRest);

    // And the log carries that op 1:1.
    const log = await buildChangeLogDocx(
      ops.map((o) => ({ location: 'Dokumenttext', before: o.find, after: o.replace, basis: REQ.id, rationale: 'Test' })),
      { sourceFilename: 'a.docx', improvedFilename: 'b.docx', date: new Date('2026-07-18') },
    );
    const logText = (await mammoth.extractRawText({ buffer: log })).value;
    expect(logText).toContain(STALE);
    expect(logText).toContain(REQ.id);
  });
});

describe('executeImproveDocument', () => {
  beforeEach(() => fakeDb.reset());

  it('DOCX: applies KB-grounded corrections + appendix, delivers two artifacts, original untouched', async () => {
    const original = await makeDocx(['Einleitung.', STALE]);
    const docId = await storeDocument(
      { filename: 'policy.docx', type: 'policy', textContent: `Einleitung. ${STALE}`, excelBuffer: original },
      SESSION,
    );
    await saveFindings(SESSION, docId, [finding('GAP-001')]);

    const res = await executeImproveDocument(
      {
        documentId: docId,
        corrections: [{ find: STALE, requirementId: REQ.id }],
        appendRecommendations: true,
      },
      CTX,
    );

    expect(res.replacements).toBe(1);
    expect(res.appendedRecommendations).toBeGreaterThanOrEqual(1);
    expect(res.attachments).toHaveLength(2);

    // Original bytes untouched in the store.
    const orig = await getDocument(docId, SESSION);
    expect(Buffer.compare(orig!.excelBuffer!, original)).toBe(0);

    // Improved artifact contains the KB summary, not the stale claim.
    const improved = await getDocument(res.downloadId, SESSION);
    const text = (await mammoth.extractRawText({ buffer: improved!.excelBuffer! })).value;
    expect(text).not.toContain(STALE);
    expect(text).toContain(`[${REQ.id}]`);
    expect(text).toContain('Regulatorische Ergänzungen (AEGIS)');

    // Change log names the change and its basis.
    const log = await getDocument(res.changeLogDownloadId, SESSION);
    const logText = (await mammoth.extractRawText({ buffer: log!.excelBuffer! })).value;
    expect(logText).toContain(STALE);
    expect(logText).toContain(REQ.id);
  });

  it('unknown requirement ids are skipped, never invented; nothing changes when none resolve', async () => {
    const original = await makeDocx([STALE]);
    const docId = await storeDocument(
      { filename: 'p.docx', type: 'policy', textContent: STALE, excelBuffer: original },
      SESSION,
    );
    await expect(
      executeImproveDocument(
        { documentId: docId, corrections: [{ find: STALE, requirementId: 'R-NOPE-999' }] },
        CTX,
      ),
    ).rejects.toThrow(/auflösbar/);
  });

  it('PDF: delivers the improved version as a NEW document with an honest note', async () => {
    const docId = await storeDocument(
      { filename: 'scan-frei.pdf', type: 'policy', textContent: `Absatz eins.\n\n${STALE}`, excelBuffer: Buffer.from('%PDF-1.7') },
      SESSION,
    );
    const res = await executeImproveDocument(
      { documentId: docId, corrections: [{ find: STALE, requirementId: REQ.id }] },
      CTX,
    );
    expect(res.filename).toMatch(/AEGIS-überarbeitet\.docx$/);
    expect(res.note).toMatch(/nicht layouterhaltend/);
    const improved = await getDocument(res.downloadId, SESSION);
    const text = (await mammoth.extractRawText({ buffer: improved!.excelBuffer! })).value;
    expect(text).toContain(`[${REQ.id}]`);
    expect(text).toMatch(/Original bleibt unverändert|Original ist ein PDF/);
  });

  it('redirects PPTX and XLSX to their format-preserving tools', async () => {
    const pptxId = await storeDocument(
      { filename: 'deck.pptx', type: 'policy', textContent: 'x', excelBuffer: Buffer.from('PK') },
      SESSION,
    );
    await expect(executeImproveDocument({ documentId: pptxId }, CTX)).rejects.toThrow(/improve_uploaded_deck/);

    const xlsxId = await storeDocument(
      { filename: 'wb.xlsx', type: 'policy', textContent: 'x', excelBuffer: Buffer.from('PK') },
      SESSION,
    );
    await expect(executeImproveDocument({ documentId: xlsxId }, CTX)).rejects.toThrow(/fill_template/);
  });

  it('appendRecommendations without prior analysis demands analyze_document first', async () => {
    const original = await makeDocx(['Text.']);
    const docId = await storeDocument(
      { filename: 'p.docx', type: 'policy', textContent: 'Text.', excelBuffer: original },
      SESSION,
    );
    await expect(
      executeImproveDocument({ documentId: docId, appendRecommendations: true }, CTX),
    ).rejects.toThrow(/analyze_document/);
  });
});
