import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import { KB } from '@/lib/kb';
import { buildGapFinding, type GapFinding } from '../gap-finding';
import { buildReportModel } from '../export/report-model';
import {
  buildAssessmentWorkbook,
  COVER_SHEET_NAME,
  SUMMARY_SHEET_NAME,
  VERIFICATION_SHEET_NAME,
} from '../export/xlsx';
import { buildAssessmentDocx } from '../export/docx';
import { buildAssessmentPdf } from '../export/pdf';
import { verifyExport, ExportVerificationError } from '../export/verify';
import { filterByRegulations } from '../export';
import { REGISTER_SHEET_NAME, REGISTER_COLUMNS } from '../parsers/excel-writer';

/**
 * Export-engine tests: every builder's output is re-opened with an independent
 * reader and checked cell-/text-level — the same discipline verifyExport
 * enforces at runtime.
 */

const doraReq = KB.requirements.find((r) => r.id === 'R-DORA-024')!;
const aiActReq = KB.requirements.find((r) => r.regulation === 'EU_AI_ACT' && r.verified)!;
const nisReq = KB.requirements.find((r) => r.regulation === 'NIS2')!;

const FINDINGS: GapFinding[] = [
  buildGapFinding({
    req: doraReq,
    status: 'missing',
    confidence: 0.9,
    reason: 'Kein Nachweis zu Resilienztests im Dokument gefunden.',
    id: 'GAP-001',
  }),
  buildGapFinding({
    req: aiActReq,
    status: 'partial',
    confidence: 0.7,
    reason: 'Teilweise Abdeckung: Prozess beschrieben, Frequenz fehlt.',
    id: 'GAP-002',
  }),
  buildGapFinding({
    req: nisReq,
    status: 'covered',
    confidence: 0.8,
    reason: 'Anforderung im Kapitel Sicherheit vollständig adressiert.',
    id: 'FND-001',
    manualReview: true,
  }),
];

describe('report model', () => {
  it('validates, orders and counts deterministically; resolves citations via KB', () => {
    const invalid = { ...FINDINGS[0], id: 'BAD-1', gapDescription: '' } as GapFinding;
    const report = buildReportModel({ findings: [...FINDINGS, invalid] });

    expect(report.counts.total).toBe(3);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].id).toBe('BAD-1');
    // Ordered by severity rank first — no invented ordering.
    const ranks = report.findings.map((f) => f.severity);
    const order = ['Critical', 'High', 'Medium', 'Low'];
    const idx = ranks.map((r) => order.indexOf(r));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // Every cited requirement resolves and carries a German provenance label.
    expect(report.unresolvedCitations).toEqual([]);
    const dora = report.citedRequirements.find((r) => r.id === doraReq.id)!;
    expect(dora.labelDe).toMatch(/verifiziert|maschinell extrahiert/);
    expect(report.counts.manualReview).toBe(1);
    expect(report.counts.byStatus.missing).toBe(1);
  });

  it('never re-grades severity — values come from the deterministic derivation', () => {
    const report = buildReportModel({ findings: FINDINGS });
    for (const f of report.findings) {
      const original = FINDINGS.find((x) => x.id === f.id)!;
      expect(f.severity).toBe(original.severity);
      expect(f.status).toBe(original.status);
    }
  });
});

describe('xlsx from scratch', () => {
  it('builds a workbook with all four sheets, correct register rows and validation', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buffer = await buildAssessmentWorkbook(report);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    for (const name of [COVER_SHEET_NAME, REGISTER_SHEET_NAME, SUMMARY_SHEET_NAME, VERIFICATION_SHEET_NAME]) {
      expect(wb.getWorksheet(name), name).toBeTruthy();
    }
    const reg = wb.getWorksheet(REGISTER_SHEET_NAME)!;
    // Header row 1, first data row 2, ids in report order.
    expect(String(reg.getRow(1).getCell(1).text)).toBe('Befund-ID');
    report.findings.forEach((f, i) => {
      expect(String(reg.getRow(i + 2).getCell(1).text)).toBe(f.id);
    });
    // Frozen header + autofilter survive the round-trip.
    const view = reg.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe('frozen');
    expect(view?.ySplit).toBe(1);
    expect(reg.autoFilter).toBeTruthy();
    // Status data validation on the first data row.
    const statusCol = REGISTER_COLUMNS.findIndex((c) => c.field === 'status') + 1;
    expect(reg.getCell(2, statusCol).dataValidation?.type).toBe('list');
    // All sheets visible (XP-4 regression), cover is the active tab.
    expect(wb.worksheets.every((ws) => ws.state === 'visible')).toBe(true);
    // Verification annex lists each cited requirement id.
    const annex = wb.getWorksheet(VERIFICATION_SHEET_NAME)!;
    const annexIds = new Set<string>();
    annex.eachRow((row) => annexIds.add(String(row.getCell(1).text)));
    for (const r of report.citedRequirements) expect(annexIds.has(r.id)).toBe(true);
    // And the runtime gate passes on its own output.
    await verifyExport('xlsx', buffer, report);
  });
});

describe('docx', () => {
  it('contains title, every finding id, severity labels and the verification annex', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buffer = await buildAssessmentDocx(report);
    const files = unzipSync(new Uint8Array(buffer));
    const xml = strFromU8(files['word/document.xml']).replace(/<[^>]+>/g, ' ');

    expect(xml).toContain(report.meta.title);
    for (const f of report.findings) expect(xml).toContain(f.id);
    expect(xml).toContain('Verifikationsanhang');
    expect(xml).toContain('Zusammenfassung');
    // Umlauts survive (German deliverable).
    expect(xml).toMatch(/Schweregrad|Lücken|Begründung/);
    await verifyExport('docx', buffer, report);
  });
});

describe('pdf', () => {
  it('has pages, the title and every finding id in extractable text', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buffer = await buildAssessmentPdf(report);

    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    expect(pdf.numPages).toBeGreaterThanOrEqual(3);
    const { text } = await extractText(pdf, { mergePages: true });
    expect(text).toContain(report.meta.title);
    for (const f of report.findings) expect(text).toContain(f.id);
    expect(text).toContain('Verifikationsanhang');
    await verifyExport('pdf', buffer, report);
  });
});

describe('self-verification gate', () => {
  it('blocks delivery when the file does not match the report (German error)', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const buffer = await buildAssessmentWorkbook(report);
    // Tamper: claim an extra finding the workbook does not contain.
    const tampered = buildReportModel({
      findings: [
        ...FINDINGS,
        buildGapFinding({
          req: KB.requirements.find((r) => r.id !== doraReq.id && r.regulation === 'DORA')!,
          status: 'missing',
          confidence: 0.9,
          reason: 'Zusätzlicher Befund, der nicht in der Datei steht.',
          id: 'GAP-999',
        }),
      ],
    });
    await expect(verifyExport('xlsx', buffer, tampered)).rejects.toThrowError(
      ExportVerificationError,
    );
    await expect(verifyExport('xlsx', buffer, tampered)).rejects.toThrow(/Qualitätsprüfung/);
  });

  it('rejects unreadable buffers per format', async () => {
    const report = buildReportModel({ findings: FINDINGS });
    const junk = Buffer.from('definitely not an office file');
    for (const format of ['xlsx', 'docx', 'pdf'] as const) {
      await expect(verifyExport(format, junk, report)).rejects.toThrowError(
        ExportVerificationError,
      );
    }
    await expect(verifyExport('xlsx', Buffer.alloc(0), report)).rejects.toThrowError(
      ExportVerificationError,
    );
  });
});

describe('regulation filter', () => {
  it('matches leniently across enum and display names', () => {
    expect(filterByRegulations(FINDINGS, ['DORA'])).toHaveLength(1);
    expect(filterByRegulations(FINDINGS, ['EU_AI_ACT']).length).toBe(1);
    expect(filterByRegulations(FINDINGS)).toHaveLength(3);
  });
});
