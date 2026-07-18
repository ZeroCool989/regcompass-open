import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';

export type ExcelSheet = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
};

export type ExcelData = {
  sheetNames: string[];
  sheets: ExcelSheet[];
};

/**
 * Extraction result with honest size accounting. The former parsers silently
 * sliced everything to 100k chars — findings about the dropped tail of a long
 * policy were then simply wrong (review 2026-07, DOC-2). Extraction now
 * returns the FULL text; only a high safety ceiling applies, and crossing it
 * is reported, surfaced to the user, and never silent.
 */
export type ParsedText = {
  text: string;
  /** Characters the document actually yielded (before any ceiling). */
  totalChars: number;
  /** True only when the safety ceiling cut the text — always surfaced to the user. */
  truncated: boolean;
};

/**
 * Safety ceiling for extracted text (chars), env-overridable. Sized far above
 * any real policy (2M chars ≈ 700+ pages); the deterministic coverage engine
 * scans strings, so large documents are cheap — the ceiling only guards
 * memory/DB rows against pathological inputs.
 */
function maxDocChars(): number {
  const v = Number(process.env.AEGIS_MAX_DOC_CHARS);
  return Number.isFinite(v) && v > 0 ? v : 2_000_000;
}

export function capText(text: string): ParsedText {
  const cap = maxDocChars();
  const totalChars = text.length;
  if (totalChars <= cap) return { text, totalChars, truncated: false };
  return { text: text.slice(0, cap), totalChars, truncated: true };
}

export async function parsePDF(buffer: Buffer): Promise<string> {
  // unpdf bundles a serverless-ready pdfjs build — no native @napi-rs/canvas and
  // no separate pdf.worker.mjs file — so PDF extraction works in the Vercel
  // serverless runtime, where the previous pdf-parse / pdfjs-dist 5.x stack
  // failed to load (native binary + worker tracing → 500 on every upload).
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join('\n') : text;
  return merged;
}

export async function parseDOCX(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// A .pptx is an OPC (ZIP) container. Slide text lives in
// `ppt/slides/slideN.xml` inside `<a:t>` runs grouped by `<a:p>` paragraphs;
// speaker notes live in `ppt/notesSlides/notesSlideN.xml`. We unzip with fflate
// (tiny, pure-JS, serverless-safe — same rationale as unpdf for PDF) and pull
// the run text. No native binary, no DOM/XML library needed for this shape.
const PPTX_RUN_RE = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
const PPTX_PARA_RE = /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;
const PPTX_SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const PPTX_NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // ampersand last so the others aren't double-decoded
}

function pptxRunsToText(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(PPTX_RUN_RE)) out.push(decodeXmlEntities(m[1]));
  return out;
}

/** Extract readable text from one slide/notes XML: runs joined per paragraph, paragraphs per line. */
function extractSlideXmlText(xml: string): string {
  const paragraphs = xml.match(PPTX_PARA_RE);
  const lines = paragraphs
    ? paragraphs.map((p) => pptxRunsToText(p).join(''))
    : pptxRunsToText(xml); // fallback when <a:p> grouping is absent
  return lines.filter((l) => l.trim().length > 0).join('\n');
}

function pptxSlideNumber(path: string, re: RegExp): number {
  const m = path.match(re);
  return m ? Number(m[1]) : 0;
}

/**
 * Cumulative decompressed-size ceiling for OOXML containers (zip-bomb guard,
 * review 2026-07 DOC-7). A legitimate presentation's XML parts stay far below
 * this; a crafted archive inflating to gigabytes gets rejected instead of
 * exhausting serverless memory.
 */
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

function guardInflatedSize(files: Record<string, Uint8Array>): void {
  let total = 0;
  for (const data of Object.values(files)) {
    total += data.length;
    if (total > MAX_INFLATED_BYTES) {
      throw new Error(
        'Das Archiv entpackt sich auf eine unplausibel große Datenmenge und wurde aus Sicherheitsgründen abgelehnt.',
      );
    }
  }
}

export async function parsePPTX(buffer: Buffer): Promise<string> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    throw new Error(`PPTX is not a readable OPC archive: ${(err as Error).message}`);
  }
  guardInflatedSize(files);

  const slidePaths = Object.keys(files)
    .filter((p) => PPTX_SLIDE_RE.test(p))
    .sort((a, b) => pptxSlideNumber(a, PPTX_SLIDE_RE) - pptxSlideNumber(b, PPTX_SLIDE_RE));
  if (slidePaths.length === 0) {
    throw new Error('No slides found in the PowerPoint file.');
  }

  const decoder = new TextDecoder();
  const sections: string[] = [];

  for (const path of slidePaths) {
    const n = pptxSlideNumber(path, PPTX_SLIDE_RE);
    const body = extractSlideXmlText(decoder.decode(files[path]));
    sections.push(body ? `[Folie ${n}]\n${body}` : `[Folie ${n}]`);
  }

  // Speaker notes carry substantive detail in many decks — append them so the
  // gap analysis sees them too. Numbered like slides; empty notes are skipped.
  const notesPaths = Object.keys(files)
    .filter((p) => PPTX_NOTES_RE.test(p))
    .sort((a, b) => pptxSlideNumber(a, PPTX_NOTES_RE) - pptxSlideNumber(b, PPTX_NOTES_RE));
  const notes: string[] = [];
  for (const path of notesPaths) {
    const n = pptxSlideNumber(path, PPTX_NOTES_RE);
    const body = extractSlideXmlText(decoder.decode(files[path]));
    if (body.trim()) notes.push(`[Notizen Folie ${n}]\n${body}`);
  }

  const all = notes.length
    ? `${sections.join('\n\n')}\n\n[Sprechernotizen]\n\n${notes.join('\n\n')}`
    : sections.join('\n\n');
  return all;
}

function cellText(cell: ExcelJS.Cell): string {
  // `cell.text` resolves rich text, formula results, and hyperlinks to a
  // display string; it can still be undefined for pristine cells.
  return String(cell.text ?? '');
}

/**
 * Parse an .xlsx workbook into headers + string rows. Row 1 of each sheet is
 * treated as the header row (matching the previous sheet_to_json behaviour);
 * empty header cells are named `Column<n>` so row values are never dropped.
 */
export async function parseExcelToSheets(buffer: Buffer): Promise<ExcelData> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheets: ExcelSheet[] = workbook.worksheets.map((ws) => {
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      headers[col - 1] = cellText(cell);
    });
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) headers[i] = `Column${i + 1}`;
    }

    const rows: Record<string, string>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const rec: Record<string, string> = {};
      for (const h of headers) rec[h] = '';
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const header = headers[col - 1];
        if (header) rec[header] = cellText(cell);
      });
      rows.push(rec);
    });

    return { name: ws.name, headers, rows };
  });

  return { sheetNames: sheets.map((s) => s.name), sheets };
}
