import { describe, expect, it, vi } from 'vitest';

// Deterministic engine only — the semantic pass is covered in its own suite.
process.env.AEGIS_SEMANTIC_PASS = '0';

import { KB } from '@/lib/kb';
import { buildGapFinding, type GapFinding } from '../gap-finding';
import { buildReportModel } from '../export/report-model';
import { buildAssessmentWorkbook } from '../export/xlsx';
import { buildAssessmentDocx } from '../export/docx';
import { buildAssessmentPdf } from '../export/pdf';
import { parseDOCX, parseExcelToSheets, parsePDF, capText } from '../parsers';
import { REGISTER_SHEET_NAME } from '../parsers/excel-writer';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { storeDocument } from '../document-store';
import { executeAnalyzeDocument } from '../tools/analyze_document';

const SESSION = 'roundtrip-session';

const req = KB.requirements.find((r) => r.id === 'R-DORA-024')!;
const FINDINGS: GapFinding[] = [
  buildGapFinding({
    req,
    status: 'missing',
    confidence: 0.9,
    reason: 'Kein Nachweis zu Resilienztests gefunden.',
    id: 'GAP-001',
  }),
];

/**
 * Round-trip guarantee: files the export engine generates must re-ingest
 * cleanly through the SAME parsers uploads use, pass the no-text guard, and
 * run through the analysis without error.
 */
describe('export → re-ingest round-trip', () => {
  it('XLSX: re-parses with the register structure recognized', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buf = await buildAssessmentWorkbook(report);
    const excel = await parseExcelToSheets(buf);
    expect(excel.sheetNames).toContain(REGISTER_SHEET_NAME);
    const register = excel.sheets.find((s) => s.name === REGISTER_SHEET_NAME)!;
    expect(register.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(register.rows)).toContain('R-DORA-024');
  });

  it('DOCX: re-parses to analyzable text and the analysis runs', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buf = await buildAssessmentDocx(report);
    const parsed = capText(await parseDOCX(buf));
    expect(parsed.truncated).toBe(false);
    expect(parsed.text.replace(/\s+/g, '').length).toBeGreaterThan(50);

    const docId = await storeDocument(
      { filename: 'reimport.docx', type: 'policy', textContent: parsed.text, excelBuffer: buf },
      SESSION,
    );
    const res = await executeAnalyzeDocument({ documentId: docId, targetRegulation: 'DORA' }, { sessionId: SESSION });
    expect(res.totalRequirementsChecked).toBeGreaterThan(0);
    expect(res.processingNote).toMatch(/vollständig analysiert/i);
  });

  it('PDF: re-parses to analyzable text (no-text guard passes)', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buf = await buildAssessmentPdf(report);
    const parsed = capText(await parsePDF(buf));
    expect(parsed.text.replace(/\s+/g, '').length).toBeGreaterThan(50);
    expect(parsed.text).toContain('R-DORA-024');
  });
});
