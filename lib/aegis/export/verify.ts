import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import { REGISTER_SHEET_NAME } from '../parsers/excel-writer';
import {
  COVER_SHEET_NAME,
  SUMMARY_SHEET_NAME,
  VERIFICATION_SHEET_NAME,
} from './xlsx';
import type { AssessmentReport } from './report-model';
import type { ExportFormat } from './index';

/**
 * Self-verification gate (mandate: generated files must open correctly).
 * Every export buffer is re-opened with an INDEPENDENT reader and checked
 * against the report it claims to represent. A failure throws
 * `ExportVerificationError` (German, user-safe) — the caller must treat that
 * as "do not deliver".
 */

export class ExportVerificationError extends Error {
  readonly details: string[];
  constructor(format: ExportFormat, details: string[]) {
    super(
      `Die generierte ${format.toUpperCase()}-Datei hat die automatische Qualitätsprüfung nicht bestanden — ` +
        'die Datei wurde nicht ausgeliefert. Bitte den Export erneut versuchen.',
    );
    this.name = 'ExportVerificationError';
    this.details = details;
  }
}

function fail(format: ExportFormat, details: string[]): never {
  console.error(
    JSON.stringify({ event: 'export_verification_failed', format, details }),
  );
  throw new ExportVerificationError(format, details);
}

async function verifyXlsx(buffer: Buffer, report: AssessmentReport): Promise<void> {
  const problems: string[] = [];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    fail('xlsx', [`workbook unreadable: ${err instanceof Error ? err.message : 'unknown'}`]);
  }
  for (const name of [COVER_SHEET_NAME, REGISTER_SHEET_NAME, SUMMARY_SHEET_NAME, VERIFICATION_SHEET_NAME]) {
    if (!wb.getWorksheet(name)) problems.push(`missing sheet: ${name}`);
  }
  const reg = wb.getWorksheet(REGISTER_SHEET_NAME);
  if (reg) {
    for (let i = 0; i < report.findings.length; i++) {
      const idCell = String(reg.getRow(i + 2).getCell(1).text ?? '').trim();
      if (idCell !== report.findings[i].id) {
        problems.push(`register row ${i + 2}: expected ${report.findings[i].id}, got "${idCell}"`);
        break; // one mismatch is enough evidence
      }
    }
  }
  const cover = wb.getWorksheet(COVER_SHEET_NAME);
  if (cover && !String(cover.getCell(2, 2).text ?? '').includes(report.meta.title)) {
    problems.push('cover title missing');
  }
  if (problems.length) fail('xlsx', problems);
}

function docxText(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer));
  const doc = files['word/document.xml'];
  if (!doc) return '';
  // Tag-strip is enough for containment checks.
  return strFromU8(doc).replace(/<[^>]+>/g, ' ');
}

function verifyDocx(buffer: Buffer, report: AssessmentReport): void {
  const problems: string[] = [];
  let text = '';
  try {
    text = docxText(buffer);
  } catch (err) {
    fail('docx', [`archive unreadable: ${err instanceof Error ? err.message : 'unknown'}`]);
  }
  if (!text.trim()) problems.push('word/document.xml missing or empty');
  if (text && !text.includes(report.meta.title)) problems.push('title missing');
  for (const f of report.findings) {
    if (!text.includes(f.id)) {
      problems.push(`finding ${f.id} missing`);
      break;
    }
  }
  if (report.findings.length > 0 && !text.includes('Verifikationsanhang')) {
    problems.push('verification annex missing');
  }
  if (problems.length) fail('docx', problems);
}

async function verifyPdf(buffer: Buffer, report: AssessmentReport): Promise<void> {
  const problems: string[] = [];
  let text = '';
  let pageCount = 0;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    pageCount = pdf.numPages;
    const extracted = await extractText(pdf, { mergePages: true });
    text = extracted.text;
  } catch (err) {
    fail('pdf', [`pdf unreadable: ${err instanceof Error ? err.message : 'unknown'}`]);
  }
  if (pageCount < 1) problems.push('no pages');
  if (!text.includes(report.meta.title)) problems.push('title missing');
  for (const f of report.findings) {
    if (!text.includes(f.id)) {
      problems.push(`finding ${f.id} missing`);
      break;
    }
  }
  if (problems.length) fail('pdf', problems);
}

/** Verify a generated export buffer against its report. Throws on failure. */
export async function verifyExport(
  format: ExportFormat,
  buffer: Buffer,
  report: AssessmentReport,
): Promise<void> {
  if (buffer.length === 0) fail(format, ['empty buffer']);
  if (format === 'xlsx') return verifyXlsx(buffer, report);
  if (format === 'docx') return verifyDocx(buffer, report);
  return verifyPdf(buffer, report);
}
