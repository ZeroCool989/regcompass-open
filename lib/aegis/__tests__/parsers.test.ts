import { describe, expect, it, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';
import { parsePDF, parseDOCX, parseExcelToSheets, parsePPTX } from '../parsers';
import {
  fillExcelTemplate,
  REGISTER_COLUMNS,
  REGISTER_SHEET_NAME,
  OUTLOOK_SHEET_NAME,
  LEGACY_SHEET_NAME,
  type GapFinding,
} from '../parsers/excel-writer';
import type { OutlookItem } from '../../regulatory/news-query';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { fakeDb } from './helpers/fake-db';
import { storeDocument, getDocument, deleteDocument } from '../document-store';

const SESSION = 'test-session-1';

// ───────────────────────── Excel parse ─────────────────────────

async function makeTestExcel(
  sheets: Record<string, Record<string, string>[]>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    if (rows.length > 0) {
      const headers = Object.keys(rows[0]);
      ws.addRow(headers);
      for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
    }
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe('parseExcelToSheets', () => {
  it('parses sheets with correct names, headers, and row counts', async () => {
    const buf = await makeTestExcel({
      Übersicht: [
        { Regulation: 'DORA', Artikel: 'Art. 5', Status: '' },
        { Regulation: 'GDPR', Artikel: 'Art. 6', Status: 'done' },
      ],
      Details: [{ Spalte1: 'a', Spalte2: 'b' }],
    });

    const result = await parseExcelToSheets(buf);
    expect(result.sheetNames).toEqual(['Übersicht', 'Details']);
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0].headers).toEqual(['Regulation', 'Artikel', 'Status']);
    expect(result.sheets[0].rows).toHaveLength(2);
    expect(result.sheets[1].headers).toEqual(['Spalte1', 'Spalte2']);
    expect(result.sheets[1].rows).toHaveLength(1);
  });

  it('reads cell values into header-keyed records', async () => {
    const buf = await makeTestExcel({
      Sheet1: [{ Regulation: 'DORA', Artikel: 'Art. 5', Status: 'offen' }],
    });
    const result = await parseExcelToSheets(buf);
    expect(result.sheets[0].rows[0]).toEqual({
      Regulation: 'DORA',
      Artikel: 'Art. 5',
      Status: 'offen',
    });
  });

  it('handles empty sheets', async () => {
    const buf = await makeTestExcel({ Empty: [] });
    const result = await parseExcelToSheets(buf);
    expect(result.sheets[0].headers).toEqual([]);
    expect(result.sheets[0].rows).toEqual([]);
  });
});

// ───────────────────────── Excel fill ─────────────────────────

describe('fillExcelTemplate', () => {
  const findings: GapFinding[] = [
    {
      id: 'GAP-001',
      requirementId: 'R-DORA-001',
      regulation: 'DORA',
      article: 'Art. 5',
      requirementTitle: 'ICT Risk Management',
      requirementArea: 'Risikomanagement',
      policySection: 'Abschnitt 4',
      policyExcerpt: 'Die Bank betreibt ein ICT-Risikomanagement-Rahmenwerk.',
      status: 'partial',
      gapDescription: 'ICT-Risikomanagement ist nur teilweise abgedeckt; Schwellenwerte fehlen.',
      riskImpact:
        'Ohne vollständiges Rahmenwerk kann operationelle Resilienz nicht nachgewiesen werden.',
      severity: 'High',
      recommendation:
        'ICT-Risikomanagement-Rahmenwerk vollständig dokumentieren und jährlich testen gemäss DORA Art. 5.',
      evidence: 'Policy-Nachweis: „ICT-Risikomanagement-Rahmenwerk". Bewertet gegen R-DORA-001.',
      citations: ['R-DORA-001', 'DORA Art. 5'],
      confidence: 0.7,
      reason: 'Bereich adressiert, spezifische Anforderung jedoch unvollständig.',
    },
    {
      id: 'GAP-002',
      requirementId: 'R-GDPR-010',
      regulation: 'GDPR',
      article: 'Art. 25',
      requirementTitle: 'Data Protection by Design',
      requirementArea: 'Daten',
      policySection: '',
      policyExcerpt: '„Data Protection by Design" wird im Dokument nicht ausdrücklich behandelt.',
      status: 'missing',
      gapDescription: 'Das Dokument adressiert Data Protection by Design nicht.',
      riskImpact: 'Ohne Privacy-by-Design drohen Aufsichtsmassnahmen und Bussgelder.',
      severity: 'Critical',
      recommendation:
        'Privacy-by-Design- und Default-Kontrollen implementieren und dokumentieren gemäss GDPR Art. 25.',
      evidence: 'Kein Nachweis im Dokument für R-GDPR-010.',
      citations: ['R-GDPR-010', 'GDPR Art. 25'],
      confidence: 0.5,
      reason: 'Kein hinreichender Nachweis im Dokument gefunden.',
    },
  ];

  it('maps every recognised column by header name — severity and risk never collide', async () => {
    const buf = await makeTestExcel({
      Sheet1: [
        {
          Regulation: 'DORA',
          Article: 'Art. 5',
          Severity: '',
          'Risk / Impact': '',
          Recommendation: '',
          Status: '',
        },
      ],
    });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const rows = (await parseExcelToSheets(result)).sheets.find((s) => s.name === 'Sheet1')!.rows;
    const row = rows[0];
    expect(row['Status']).toBe('Teilweise erfüllt');
    // Severity lands in Severity (not in Risk/Impact).
    expect(row['Severity']).toBe('High');
    expect(row['Risk / Impact']).toContain('operationelle Resilienz');
    expect(row['Risk / Impact']).not.toBe('High');
    expect(row['Recommendation']).toContain('DORA Art. 5');
  });

  it('appends missing requirements as new rows', async () => {
    const buf = await makeTestExcel({
      Sheet1: [{ Regulation: 'DORA', Article: 'Art. 5', Status: '' }],
    });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const rows = (await parseExcelToSheets(result)).sheets.find((s) => s.name === 'Sheet1')!.rows;
    expect(rows.length).toBeGreaterThan(1);
    const addedRow = rows.find((r) => r['Article'] === 'Art. 25');
    expect(addedRow).toBeDefined();
    expect(addedRow!['Regulation']).toBe('GDPR');
  });

  // Exact demo-required column order (German headers; locks against reordering).
  const EXPECTED_HEADERS = [
    'Befund-ID',
    'Regulierung',
    'Artikel / Anforderung',
    'Anforderungsbereich',
    'Policy-Abschnitt',
    'Policy-Auszug',
    'Lückenbeschreibung',
    'Risiko / Auswirkung',
    'Schweregrad',
    'Empfehlung',
    'Verantwortlich',
    'Zieldatum',
    'Status',
    'Nachweis / Quelle',
    'Begründung',
    'Priorisiert',
  ];

  it('creates a fully-populated "AEGIS Gap Register" sheet with exact column order', async () => {
    const buf = await makeTestExcel({
      Sheet1: [{ Regulation: 'DORA', Article: 'Art. 5', Status: '' }],
    });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const parsed = await parseExcelToSheets(result);
    expect(parsed.sheetNames).toContain(REGISTER_SHEET_NAME);

    const sheet = parsed.sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    // All required columns exist in the correct order.
    expect(sheet.headers).toEqual(EXPECTED_HEADERS);
    expect(REGISTER_COLUMNS.map((c) => c.header)).toEqual(EXPECTED_HEADERS);

    // At least one finding row is written.
    expect(sheet.rows.length).toBeGreaterThan(0);

    const gap1 = sheet.rows.find((r) => r['Befund-ID'] === 'GAP-001')!;
    expect(gap1).toBeDefined();
    expect(gap1['Regulierung']).toBe('DORA');
    expect(gap1['Artikel / Anforderung']).toContain('Art. 5');
    expect(gap1['Artikel / Anforderung']).toContain('ICT Risk Management');
    expect(gap1['Anforderungsbereich']).toBe('Risikomanagement');
    expect(gap1['Status']).toBe('Teilweise erfüllt');
    // Severity in its own column (German label), risk/impact is the narrative.
    expect(gap1['Schweregrad']).toBe('Hoch');
    expect(gap1['Risiko / Auswirkung']).toContain('operationelle Resilienz');
    expect(gap1['Risiko / Auswirkung']).not.toBe('High');
    // Excerpt + evidence/citation present, recommendation specific.
    expect(gap1['Policy-Auszug'].length).toBeGreaterThan(0);
    expect(gap1['Lückenbeschreibung'].length).toBeGreaterThan(0);
    expect(gap1['Nachweis / Quelle']).toContain('R-DORA-001');
    expect(gap1['Empfehlung']).toContain('DORA Art. 5');
    expect(gap1['Begründung'].length).toBeGreaterThan(0);
    expect(['Ja', 'Nein']).toContain(gap1['Priorisiert']);
  });

  it('writes findings starting at row 2 even if the template already has a 50-row register sheet', async () => {
    // Simulate an uploaded template that already contains a (banded) register
    // sheet with a header + 50 rows — the row-offset reproduction.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['Regulation', 'Article', 'Status']);
    const old = wb.addWorksheet(REGISTER_SHEET_NAME);
    old.addRow(REGISTER_COLUMNS.map((c) => c.header));
    for (let i = 0; i < 50; i++) old.addRow(REGISTER_COLUMNS.map(() => ''));
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(result as unknown as ArrayBuffer);
    const reg = out.getWorksheet(REGISTER_SHEET_NAME)!;

    // Header at row 1, findings contiguous from row 2 — no inherited empty rows.
    expect(String(reg.getRow(1).getCell(1).value ?? '')).toBe('Befund-ID');
    for (let i = 0; i < findings.length; i++) {
      expect(String(reg.getRow(2 + i).getCell(1).value ?? '')).toMatch(/^GAP-/);
    }
    // No finding rows beyond the data block (only the footer note may follow).
    expect(String(reg.getRow(2 + findings.length).getCell(1).value ?? '')).not.toMatch(/^GAP-/);
  });

  it('appends a German Human-in-the-Loop note at the end', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'DORA', Article: 'Art. 5', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(result as unknown as ArrayBuffer);
    const reg = out.getWorksheet(REGISTER_SHEET_NAME)!;
    let noteFound = '';
    reg.eachRow((row) => {
      const v = String(row.getCell(1).value ?? '');
      if (/Human-in-the-Loop/i.test(v)) noteFound = v;
    });
    expect(noteFound).toMatch(/Human-in-the-Loop/);
    expect(noteFound).toMatch(/verifizieren/i);
    expect(noteFound).not.toMatch(/[A-Za-z]+ in the loop verified/i); // German, not English
  });

  it('never writes numeric junk (e.g. "24") into Owner / Target Date', async () => {
    const junked: GapFinding[] = [
      { ...findings[0], owner: '24' as unknown as string, targetDate: '24' as unknown as string },
    ];
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'DORA', Article: 'Art. 5', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', junked);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    const row = reg.rows[0];
    expect(row['Verantwortlich']).toBe('');
    expect(row['Zieldatum']).toBe('');
  });

  it('opens on "AEGIS Gap Register" and hides the empty original sheets', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Gap Register'); // empty original sheet
    wb.addWorksheet('Reference & Legend');
    wb.addWorksheet('Sheet1').addRow(['Regulation', 'Article', 'Status']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(result as unknown as ArrayBuffer);

    const reg = out.getWorksheet(REGISTER_SHEET_NAME)!;
    expect(reg.state).toBe('visible');
    expect(out.getWorksheet('Gap Register')!.state).toBe('hidden');
    expect(out.getWorksheet('Reference & Legend')!.state).toBe('hidden');
    expect(out.getWorksheet('Sheet1')!.state).toBe('hidden');
    // Workbook opens directly on the register tab.
    const idx = out.worksheets.findIndex((w) => w.id === reg.id);
    expect(out.views[0]?.activeTab).toBe(idx);
  });

  it('removes the legacy "AEGIS Ergänzungen" sheet and writes the register instead', async () => {
    // Pre-seed a workbook that already contains the old sheet.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['Regulation', 'Article', 'Status']);
    wb.addWorksheet(LEGACY_SHEET_NAME).addRow(['Regulation', 'Artikel', 'Anforderung']);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const parsed = await parseExcelToSheets(result);
    expect(parsed.sheetNames).not.toContain(LEGACY_SHEET_NAME);
    expect(parsed.sheetNames).toContain(REGISTER_SHEET_NAME);
    // The register (not some empty sheet) is the populated output.
    const reg = parsed.sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    expect(reg.rows.length).toBeGreaterThan(0);
  });

  it('applies professional formatting (dark bold header, frozen, filter, severity/status colour)', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'DORA', Article: 'Art. 5', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result as unknown as ArrayBuffer);
    const reg = wb.getWorksheet(REGISTER_SHEET_NAME)!;

    // Header: dark fill + bold white text.
    const h1 = reg.getRow(1).getCell(1);
    expect((h1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF1F2937');
    expect(h1.font?.bold).toBe(true);
    expect(h1.font?.color?.argb).toBe('FFFFFFFF');

    // Frozen header + autofilter.
    expect(reg.views[0]?.state).toBe('frozen');
    expect(reg.autoFilter).toBeTruthy();

    // Severity + Status cells are colour-coded.
    const sevCol = EXPECTED_HEADERS.indexOf('Schweregrad') + 1;
    const statCol = EXPECTED_HEADERS.indexOf('Status') + 1;
    const dataRow = reg.getRow(2);
    expect((dataRow.getCell(sevCol).fill as ExcelJS.FillPattern).fgColor?.argb).toBeTruthy();
    expect((dataRow.getCell(statCol).fill as ExcelJS.FillPattern).fgColor?.argb).toBeTruthy();
    expect(dataRow.height).toBeGreaterThan(20); // readable row height
  });

  it('exports no meta-regulatory articles', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'X', Article: 'Y', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    for (const r of reg.rows) {
      expect(r['Artikel / Anforderung']).not.toMatch(/sanktion|sanction|befugnis|inkrafttreten|delegier|übergangs|amendment/i);
    }
  });

  it('contains no placeholder recommendations', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'X', Article: 'Y', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', findings);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    for (const r of reg.rows) {
      expect(r['Empfehlung']).not.toMatch(/^implement controls?/i);
      expect(r['Empfehlung'].length).toBeGreaterThanOrEqual(25);
    }
  });

  it('validates findings: a malformed finding is logged and skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = {
      ...findings[0],
      id: 'GAP-009',
      requirementId: 'R-BAD-001',
      severity: '' as unknown as GapFinding['severity'], // invalid → must be rejected
    };
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'Z', Article: 'Z', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', [findings[0], bad]);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    expect(reg.rows.find((r) => r['Befund-ID'] === 'GAP-009')).toBeUndefined();
    expect(reg.rows.find((r) => r['Befund-ID'] === 'GAP-001')).toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still produces the register when the sheet name is unknown (no error, no prompt)', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ A: '1' }] });
    const result = await fillExcelTemplate(buf, 'NonExistent', findings);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    expect(reg).toBeDefined();
    expect(reg.rows.length).toBeGreaterThan(0);
  });

  it('produces the register even when no sheet name is given', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ A: '1' }] });
    const result = await fillExcelTemplate(buf, undefined, findings);
    const reg = (await parseExcelToSheets(result)).sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    expect(reg.rows.length).toBeGreaterThan(0);
  });
});

// ───────────────────────── Regulatory outlook sheet ─────────────────────────

describe('fillExcelTemplate — regulatory outlook (opt-in)', () => {
  const outlook: OutlookItem[] = [
    {
      title: 'BaFin-Konsultation zu DORA-Auslagerungen',
      summary: 'Zusammenfassung.',
      relevance: 'Betrifft IKT-Drittparteienrisiko.',
      sourceName: 'BaFin',
      sourceUrl: 'https://bafin.de/dora-konsultation',
      publishedAt: new Date('2026-06-01'),
      jurisdiction: 'DE',
      tags: ['DORA'],
    },
  ];

  it('adds a "Regulatorischer Ausblick" sheet with the news echoed verbatim', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'DORA', Article: 'Art. 28', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', [], { outlook });
    const parsed = await parseExcelToSheets(result);

    expect(parsed.sheetNames).toContain(OUTLOOK_SHEET_NAME);
    const sheet = parsed.sheets.find((s) => s.name === OUTLOOK_SHEET_NAME)!;
    expect(sheet.headers).toEqual(['Datum', 'Quelle', 'Tags', 'Titel', 'Relevanz', 'Link']);
    const r = sheet.rows[0];
    expect(r['Titel']).toBe('BaFin-Konsultation zu DORA-Auslagerungen');
    expect(r['Quelle']).toBe('BaFin');
    expect(r['Relevanz']).toBe('Betrifft IKT-Drittparteienrisiko.');
    expect(r['Link']).toBe('https://bafin.de/dora-konsultation'); // every row carries a real source URL
    expect(r['Tags']).toBe('DORA');
  });

  it('does NOT add the outlook sheet when no outlook is passed (default off)', async () => {
    const buf = await makeTestExcel({ Sheet1: [{ Regulation: 'DORA', Article: 'Art. 28', Status: '' }] });
    const result = await fillExcelTemplate(buf, 'Sheet1', []);
    const parsed = await parseExcelToSheets(result);
    expect(parsed.sheetNames).not.toContain(OUTLOOK_SHEET_NAME);
  });
});

// ───────────────────────── Document Store ─────────────────────────

describe('document-store', () => {
  afterEach(() => {
    fakeDb.reset();
    vi.useRealTimers();
  });

  it('stores and retrieves a document within the owning session', async () => {
    const id = await storeDocument(
      { filename: 'test.pdf', type: 'policy', textContent: 'hello world' },
      SESSION,
    );
    const doc = await getDocument(id, SESSION);
    expect(doc).not.toBeNull();
    expect(doc!.filename).toBe('test.pdf');
    expect(doc!.textContent).toBe('hello world');
  });

  it('returns null for unknown id', async () => {
    expect(await getDocument('nonexistent-id', SESSION)).toBeNull();
  });

  it('hides documents from other sessions (ownership)', async () => {
    const id = await storeDocument(
      { filename: 'private.pdf', type: 'policy', textContent: 'secret' },
      SESSION,
    );
    expect(await getDocument(id, 'other-session')).toBeNull();
    expect(await getDocument(id, null)).toBeNull();
    expect(await getDocument(id, SESSION)).not.toBeNull();
  });

  it('deletes a document', async () => {
    const id = await storeDocument(
      { filename: 'test.txt', type: 'policy', textContent: 'some text' },
      SESSION,
    );
    expect(await deleteDocument(id, SESSION)).toBe(true);
    expect(await getDocument(id, SESSION)).toBeNull();
  });

  it('expires documents after the TTL', async () => {
    vi.useFakeTimers();
    const id = await storeDocument(
      { filename: 'temp.pdf', type: 'policy', textContent: 'expires' },
      SESSION,
    );
    expect(await getDocument(id, SESSION)).not.toBeNull();
    // Still alive after an hour (TTL is now 24h so a refresh keeps documents)…
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(await getDocument(id, SESSION)).not.toBeNull();
    // …expired well past the 24h TTL.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(await getDocument(id, SESSION)).toBeNull();
  });
});

// ───────────────────────── PDF / DOCX parsers ─────────────────────────

describe('parsePDF', () => {
  it('rejects invalid buffer with a meaningful error', async () => {
    await expect(parsePDF(Buffer.from('not a pdf'))).rejects.toThrow();
  });
});

describe('parseDOCX', () => {
  it('rejects invalid buffer with a meaningful error', async () => {
    await expect(parseDOCX(Buffer.from('not a docx'))).rejects.toThrow();
  });
});

// ───────────────────────── PPTX parser ─────────────────────────

/** Build a minimal but valid .pptx (OPC zip) from slide/notes bodies. */
function makeTestPptx(opts: {
  slides: string[]; // one or more paragraph-bodies per slide
  notes?: Record<number, string>; // 1-based slide number → notes body
}): Buffer {
  const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  const slideXml = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://x" xmlns:p="http://y"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
  };
  opts.slides.forEach((body, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(slideXml(body));
  });
  for (const [n, body] of Object.entries(opts.notes ?? {})) {
    files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(slideXml(para(body)));
  }
  return Buffer.from(zipSync(files));
}

describe('parsePPTX', () => {
  it('extracts slide text in order and decodes XML entities', async () => {
    const buf = makeTestPptx({
      slides: [
        '<a:p><a:r><a:t>ICT-Risikomanagement</a:t></a:r></a:p><a:p><a:r><a:t>Vorfallmeldung &amp; Resilienz</a:t></a:r></a:p>',
        '<a:p><a:r><a:t>Auslagerung (Art. 28)</a:t></a:r></a:p>',
      ],
    });
    const text = await parsePPTX(buf);
    expect(text).toContain('ICT-Risikomanagement');
    expect(text).toContain('Vorfallmeldung & Resilienz'); // &amp; decoded
    expect(text).toContain('Auslagerung (Art. 28)');
    expect(text).toContain('[Folie 1]');
    expect(text).toContain('[Folie 2]');
    expect(text.indexOf('[Folie 1]')).toBeLessThan(text.indexOf('[Folie 2]'));
  });

  it('joins multiple <a:t> runs within a paragraph and sorts slides numerically (slide2 before slide10)', async () => {
    const slideXml = (t: string) =>
      strToU8(`<p:sld xmlns:a="http://x"><p:txBody><a:p>${t}</a:p></p:txBody></p:sld>`);
    const buf = Buffer.from(
      zipSync({
        'ppt/slides/slide1.xml': slideXml('<a:r><a:t>Teil A </a:t></a:r><a:r><a:t>Teil B</a:t></a:r>'),
        'ppt/slides/slide2.xml': slideXml('<a:r><a:t>Zweite Folie</a:t></a:r>'),
        'ppt/slides/slide10.xml': slideXml('<a:r><a:t>Zehnte Folie</a:t></a:r>'),
      }),
    );
    const text = await parsePPTX(buf);
    expect(text).toContain('Teil A Teil B'); // runs in one paragraph are concatenated
    // Numeric, not lexicographic: slide2 must precede slide10 (lexicographic would flip it).
    expect(text.indexOf('Zweite Folie')).toBeLessThan(text.indexOf('Zehnte Folie'));
    expect(text).toContain('[Folie 10]');
  });

  it('appends speaker notes under a Sprechernotizen section', async () => {
    const buf = makeTestPptx({
      slides: ['<a:p><a:r><a:t>Folieninhalt</a:t></a:r></a:p>'],
      notes: { 1: 'Schwellenwerte fehlen noch' },
    });
    const text = await parsePPTX(buf);
    expect(text).toContain('[Sprechernotizen]');
    expect(text).toContain('Schwellenwerte fehlen noch');
    // Notes come after the slide body.
    expect(text.indexOf('Folieninhalt')).toBeLessThan(text.indexOf('Schwellenwerte fehlen noch'));
  });

  it('rejects a non-zip buffer', async () => {
    await expect(parsePPTX(Buffer.from('not a pptx'))).rejects.toThrow();
  });

  it('rejects a valid zip that contains no slides', async () => {
    const buf = Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>') }));
    await expect(parsePPTX(buf)).rejects.toThrow(/no slides/i);
  });
});
