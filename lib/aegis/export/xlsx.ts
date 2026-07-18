import ExcelJS from 'exceljs';
import {
  writeRegisterSheet,
  REGISTER_COLUMNS,
  REGISTER_SHEET_NAME,
  STATUS_LABEL,
  SEVERITY_LABEL,
} from '../parsers/excel-writer';
import { fmtDateDe, type AssessmentReport } from './report-model';

/**
 * From-scratch Excel deliverable (XP-1): a complete, professional German
 * workbook built on a fresh `ExcelJS.Workbook` — no uploaded template needed.
 * Reuses `writeRegisterSheet` so the register layout is byte-for-byte the same
 * contract as the template-fill path, and adds Deckblatt, Zusammenfassung and
 * Verifikationsanhang around it. Deterministic TS only — no model calls.
 *
 * Known limitation, deliberate: exceljs has no chart model, so the summary is
 * a formatted table (with in-cell data bars via REPT-style fills) rather than
 * a native chart.
 */

export const COVER_SHEET_NAME = 'Deckblatt';
export const SUMMARY_SHEET_NAME = 'Zusammenfassung';
export const VERIFICATION_SHEET_NAME = 'Verifikationsanhang';
export const XLSX_BUILD = 'AEGIS-workbook-de-1';

const BRAND = {
  dark: 'FF1F2937',
  accent: 'FF2563EB',
  light: 'FFF3F4F6',
  muted: 'FF6B7280',
  white: 'FFFFFFFF',
};

const SEVERITY_FILL: Record<string, string> = {
  Critical: 'FFC0392B',
  High: 'FFE67E22',
  Medium: 'FFF1C40F',
  Low: 'FF27AE60',
};

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function writeCoverSheet(wb: ExcelJS.Workbook, report: AssessmentReport): void {
  const ws = wb.addWorksheet(COVER_SHEET_NAME);
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 30;
  ws.getColumn(3).width = 80;

  const set = (row: number, labelText: string, value: string, opts?: { big?: boolean }) => {
    const l = ws.getCell(row, 2);
    l.value = labelText;
    l.font = { bold: true, color: { argb: BRAND.muted }, size: opts?.big ? 12 : 10 };
    const v = ws.getCell(row, 3);
    v.value = value;
    v.font = opts?.big
      ? { bold: true, size: 20, color: { argb: BRAND.dark } }
      : { size: 11, color: { argb: BRAND.dark } };
    v.alignment = { wrapText: true, vertical: 'top' };
  };

  ws.mergeCells(2, 2, 2, 3);
  const title = ws.getCell(2, 2);
  title.value = report.meta.title;
  title.font = { bold: true, size: 24, color: { argb: BRAND.white } };
  title.fill = fill(BRAND.dark);
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 48;

  set(4, 'Erstellt am', fmtDateDe(report.meta.generatedAt));
  set(5, 'Geltungsbereich', report.meta.scope.join(', ') || '—');
  set(6, 'Befunde gesamt', String(report.counts.total));
  set(
    7,
    'Quelle',
    report.meta.sourceRef
      ? report.meta.sourceRef.kind === 'document'
        ? `Hochgeladenes Dokument (${report.meta.sourceRef.documentId})`
        : `Unterhaltung ${report.meta.sourceRef.conversationId} (${report.meta.sourceRef.messageIds.length} Nachrichten)`
      : '—',
  );

  ws.mergeCells(9, 2, 9, 3);
  const verif = ws.getCell(9, 2);
  verif.value = `Verifikationsnachweis: ${report.auditLineDe}`;
  verif.font = { italic: true, size: 10, color: { argb: BRAND.muted } };
  verif.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(9).height = 44;

  ws.mergeCells(11, 2, 11, 3);
  const note = ws.getCell(11, 2);
  note.value = report.humanNoteDe;
  note.font = { italic: true, size: 10, color: { argb: BRAND.muted } };
  note.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(11).height = 44;
}

function writeSummarySheet(wb: ExcelJS.Workbook, report: AssessmentReport): void {
  const ws = wb.addWorksheet(SUMMARY_SHEET_NAME);
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 44;

  const header = (row: number, text: string) => {
    ws.mergeCells(row, 1, row, 3);
    const c = ws.getCell(row, 1);
    c.value = text;
    c.font = { bold: true, color: { argb: BRAND.white } };
    c.fill = fill(BRAND.dark);
    ws.getRow(row).height = 20;
  };

  // In-cell "data bar": a repeated block glyph scaled to the max count. Not a
  // native chart (exceljs has none) but reads instantly and prints safely.
  const bar = (count: number, max: number) => '█'.repeat(max > 0 ? Math.round((count / max) * 24) : 0);

  header(1, 'Befunde nach Schweregrad');
  const sevEntries = (['Critical', 'High', 'Medium', 'Low'] as const).map(
    (s) => [s, report.counts.bySeverity[s]] as const,
  );
  const sevMax = Math.max(...sevEntries.map(([, n]) => n), 1);
  sevEntries.forEach(([sev, n], i) => {
    const row = 2 + i;
    ws.getCell(row, 1).value = SEVERITY_LABEL[sev] ?? sev;
    ws.getCell(row, 2).value = n;
    const b = ws.getCell(row, 3);
    b.value = bar(n, sevMax);
    b.font = { color: { argb: SEVERITY_FILL[sev] ?? BRAND.accent } };
  });

  header(7, 'Befunde nach Status');
  const stEntries = (['missing', 'partial', 'covered', 'not_applicable'] as const).map(
    (s) => [s, report.counts.byStatus[s]] as const,
  );
  const stMax = Math.max(...stEntries.map(([, n]) => n), 1);
  stEntries.forEach(([st, n], i) => {
    const row = 8 + i;
    ws.getCell(row, 1).value = STATUS_LABEL[st];
    ws.getCell(row, 2).value = n;
    const b = ws.getCell(row, 3);
    b.value = bar(n, stMax);
    b.font = { color: { argb: BRAND.accent } };
  });

  header(13, 'Qualität');
  ws.getCell(14, 1).value = 'Manuell zu prüfende Befunde';
  ws.getCell(14, 2).value = report.counts.manualReview;
  ws.getCell(15, 1).value = 'Zitierte KB-Anforderungen';
  ws.getCell(15, 2).value = report.citedRequirements.length;
}

function writeVerificationSheet(wb: ExcelJS.Workbook, report: AssessmentReport): void {
  const ws = wb.addWorksheet(VERIFICATION_SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });
  const cols = [
    { header: 'KB-ID', width: 18 },
    { header: 'Referenz', width: 22 },
    { header: 'Titel', width: 46 },
    { header: 'Verifikationsstatus', width: 62 },
  ];
  cols.forEach((c, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = c.header;
    cell.fill = fill(BRAND.dark);
    cell.font = { bold: true, color: { argb: BRAND.white } };
    ws.getColumn(i + 1).width = c.width;
  });
  report.citedRequirements.forEach((r, i) => {
    const row = i + 2;
    ws.getCell(row, 1).value = r.id;
    ws.getCell(row, 2).value = r.ref;
    ws.getCell(row, 3).value = r.title;
    const status = ws.getCell(row, 4);
    status.value = r.labelDe;
    status.font = { color: { argb: r.verified ? 'FF27AE60' : 'FFE67E22' } };
    ws.getRow(row).alignment = { wrapText: true, vertical: 'top' };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  const noteRow = report.citedRequirements.length + 3;
  ws.mergeCells(noteRow, 1, noteRow, cols.length);
  const note = ws.getCell(noteRow, 1);
  note.value =
    'Nachvollziehbare Einzelnachweise je Eintrag: docs/governance/verification-records/ im RegCompass-Repository. ' +
    report.auditLineDe;
  note.font = { italic: true, color: { argb: BRAND.muted } };
  note.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(noteRow).height = 40;
}

/** List-validation on the register's Status column (audit-friendly editing). */
function addStatusValidation(wb: ExcelJS.Workbook, findingCount: number): void {
  const reg = wb.getWorksheet(REGISTER_SHEET_NAME);
  if (!reg || findingCount === 0) return;
  const statusCol = REGISTER_COLUMNS.findIndex((c) => c.field === 'status') + 1;
  if (statusCol === 0) return;
  const labels = Object.values(STATUS_LABEL).join(',');
  for (let r = 2; r < 2 + findingCount; r++) {
    reg.getCell(r, statusCol).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${labels}"`],
      showErrorMessage: true,
      errorTitle: 'Ungültiger Status',
      error: `Zulässig: ${labels}`,
    };
  }
}

/** Build the complete from-scratch workbook. Returns the .xlsx buffer. */
export async function buildAssessmentWorkbook(report: AssessmentReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = XLSX_BUILD;
  wb.lastModifiedBy = XLSX_BUILD;
  wb.created = report.meta.generatedAt;

  writeCoverSheet(wb, report);
  writeRegisterSheet(wb, report.findings);
  writeSummarySheet(wb, report);
  writeVerificationSheet(wb, report);
  addStatusValidation(wb, report.findings.length);

  // Cover sheet is the opening tab; every sheet stays visible (XP-4 lesson:
  // hiding sheets reads as data loss).
  for (const ws of wb.worksheets) ws.state = 'visible';
  wb.views = [
    { x: 0, y: 0, width: 28000, height: 18000, firstSheet: 0, activeTab: 0, visibility: 'visible' },
  ];

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
