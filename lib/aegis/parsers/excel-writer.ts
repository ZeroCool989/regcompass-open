import ExcelJS from 'exceljs';
import { validateGapFinding, type GapFinding, type GapStatus } from '../gap-finding';
import { auditSnapshotLine } from '../provenance';
import type { OutlookItem } from '@/lib/regulatory/news-query';

// GapFinding is now defined in ../gap-finding. Re-export for existing importers.
export type { GapFinding } from '../gap-finding';

export type FillOptions = {
  appendRows?: boolean;
  fillExisting?: boolean;
  addMissingSheet?: boolean;
  /** Opt-in regulatory-radar items → adds a "Regulatorischer Ausblick" sheet (echo only). */
  outlook?: OutlookItem[];
};

/**
 * Owner / Target Date are never auto-derived. Only emit a value if it is a
 * meaningful, non-numeric string — never numeric junk (e.g. a stray "24") — so
 * these columns stay blank in the demo deliverable.
 */
function cleanOptional(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s || /^\d+$/.test(s)) return '';
  return s;
}

/** German display label for the severity enum (internal value stays English for colour-coding). */
const SEVERITY_LABEL: Record<string, string> = {
  Critical: 'Kritisch',
  High: 'Hoch',
  Medium: 'Mittel',
  Low: 'Niedrig',
};

/** German display label for the status enum (consulting deliverable). */
const STATUS_LABEL: Record<GapStatus, string> = {
  covered: 'Erfüllt',
  partial: 'Teilweise erfüllt',
  missing: 'Nicht erfüllt',
  not_applicable: 'Nicht anwendbar',
};

/**
 * Explicit value for each LOGICAL field, derived from the typed GapFinding —
 * never positional. Both the template-fill and the generated register map
 * through this single source of truth so a field can never land in the wrong
 * column.
 */
const FIELD_VALUE: Record<string, (f: GapFinding) => string> = {
  findingId: (f) => f.id,
  regulation: (f) => f.regulation,
  article: (f) => f.article,
  requirementArea: (f) => f.requirementArea,
  requirement: (f) => f.requirementTitle,
  requirementId: (f) => f.requirementId,
  policySection: (f) => f.policySection,
  pageNumber: (f) => (f.pageNumber != null ? String(f.pageNumber) : ''),
  policyExcerpt: (f) => f.policyExcerpt,
  status: (f) => STATUS_LABEL[f.status],
  severity: (f) => f.severity,
  gapDescription: (f) => f.gapDescription,
  riskImpact: (f) => f.riskImpact,
  recommendation: (f) => f.recommendation,
  evidence: (f) => f.evidence,
  citations: (f) => f.citations.join(', '),
  confidence: (f) => `${Math.round(f.confidence * 100)}%`,
  owner: (f) => f.owner ?? '',
  targetDate: (f) => f.targetDate ?? '',
};

/**
 * Header aliases per logical field (German + English). Severity and risk/impact
 * are kept strictly separate so severity never bleeds into the risk column.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  findingId: ['finding id', 'finding-id', 'findingid', 'befund-id', 'befund id', 'finding nr', 'lfd. nr', 'lfd nr'],
  regulation: ['regulation', 'verordnung', 'regulierung', 'gesetz', 'regelwerk', 'rahmenwerk'],
  article: ['artikel', 'article', 'art.', 'paragraf', 'paragraph', '§'],
  requirementArea: ['requirement area', 'anforderungsbereich', 'themengebiet', 'bereich', 'domain', 'kategorie', 'category', 'thema'],
  requirement: ['requirement title', 'requirement', 'anforderung', 'anforderungstitel', 'kontrolle', 'control', 'massnahme', 'maßnahme'],
  requirementId: ['requirement id', 'req id', 'kb-referenz', 'kb referenz', 'kb-id', 'kb id'],
  policySection: ['policy section', 'abschnitt', 'kapitel', 'fundstelle', 'section'],
  pageNumber: ['page number', 'seitenzahl', 'page', 'seite'],
  policyExcerpt: ['policy excerpt', 'excerpt', 'auszug', 'policy-zitat', 'policy zitat', 'textstelle', 'policy text'],
  status: ['status', 'bewertung', 'assessment', 'ergebnis', 'result', 'erfüllung', 'compliance', 'konformität'],
  severity: ['severity', 'schweregrad', 'kritikalität', 'priorität', 'priority', 'prio', 'einstufung', 'dringlichkeit'],
  gapDescription: ['gap description', 'lückenbeschreibung', 'gap', 'lücke', 'abweichung', 'feststellung', 'beschreibung', 'finding description'],
  riskImpact: ['risk / impact', 'risk/impact', 'risk impact', 'risiko/auswirkung', 'risiko / auswirkung', 'auswirkung', 'risiko', 'risk', 'impact', 'folgen'],
  recommendation: ['recommendation', 'empfehlung', 'handlungsempfehlung', 'remediation', 'remediierung', 'action', 'aktion'],
  evidence: ['evidence', 'nachweis', 'beleg', 'citation', 'quelle', 'referenz'],
  citations: ['citations', 'quellen', 'referenzen', 'zitate'],
  confidence: ['confidence', 'konfidenz', 'vertrauensgrad', 'sicherheit'],
  owner: ['owner', 'verantwortlich', 'verantwortung', 'zuständig', 'eigentümer', 'responsible'],
  targetDate: ['target date', 'due date', 'zieldatum', 'fälligkeit', 'frist', 'termin', 'deadline'],
};

/**
 * Resolve template headers → logical fields by NAME (never position). Greedy:
 * exact-match beats startsWith beats includes, longer aliases win, and each
 * field/column is used at most once so two fields can't collide on one column.
 */
function resolveColumns(headers: string[]): Record<string, number> {
  const candidates: { field: string; col: number; score: number }[] = [];
  headers.forEach((h, i) => {
    const hl = (h ?? '').toLowerCase().trim();
    if (!hl) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      let best = 0;
      for (const a of aliases) {
        if (hl === a) best = Math.max(best, 100 + a.length);
        else if (hl.startsWith(a)) best = Math.max(best, 60 + a.length);
        else if (hl.includes(a)) best = Math.max(best, 30 + a.length);
      }
      if (best > 0) candidates.push({ field, col: i + 1, score: best });
    }
  });
  candidates.sort((a, b) => b.score - a.score);

  const map: Record<string, number> = {};
  const takenCols = new Set<number>();
  for (const c of candidates) {
    if (map[c.field] != null || takenCols.has(c.col)) continue;
    map[c.field] = c.col;
    takenCols.add(c.col);
  }
  return map;
}

/**
 * Ordered columns of the generated, fully-controlled AEGIS register sheet — the
 * demo deliverable. Each column maps explicitly from the typed GapFinding (never
 * by position). This exact order/headers is the contract the demo expects.
 */
const REGISTER_COLUMNS: { header: string; field: string; get: (f: GapFinding) => string; wide?: boolean }[] = [
  { header: 'Befund-ID', field: 'findingId', get: (f) => f.id },
  { header: 'Regulierung', field: 'regulation', get: (f) => f.regulation },
  {
    header: 'Artikel / Anforderung',
    field: 'articleRequirement',
    get: (f) => (f.requirementTitle ? `${f.article} — ${f.requirementTitle}` : f.article),
    wide: true,
  },
  { header: 'Anforderungsbereich', field: 'requirementArea', get: (f) => f.requirementArea },
  { header: 'Policy-Abschnitt', field: 'policySection', get: (f) => f.policySection },
  { header: 'Policy-Auszug', field: 'policyExcerpt', get: (f) => f.policyExcerpt, wide: true },
  { header: 'Lückenbeschreibung', field: 'gapDescription', get: (f) => f.gapDescription, wide: true },
  { header: 'Risiko / Auswirkung', field: 'riskImpact', get: (f) => f.riskImpact, wide: true },
  { header: 'Schweregrad', field: 'severity', get: (f) => SEVERITY_LABEL[f.severity] ?? f.severity },
  { header: 'Empfehlung', field: 'recommendation', get: (f) => f.recommendation, wide: true },
  { header: 'Verantwortlich', field: 'owner', get: (f) => cleanOptional(f.owner) },
  { header: 'Zieldatum', field: 'targetDate', get: (f) => cleanOptional(f.targetDate) },
  { header: 'Status', field: 'status', get: (f) => STATUS_LABEL[f.status] },
  {
    header: 'Nachweis / Quelle',
    field: 'evidenceCitation',
    get: (f) => (f.citations.length ? `${f.evidence} [${f.citations.join(', ')}]` : f.evidence),
    wide: true,
  },
  { header: 'Begründung', field: 'reason', get: (f) => f.reason, wide: true },
  { header: 'Priorisiert', field: 'promoted', get: (f) => (f.promoted ? 'Ja' : 'Nein') },
];

const REGISTER_SHEET_NAME = 'AEGIS Lückenanalyse';
const LEGACY_SHEET_NAME = 'AEGIS Ergänzungen';
/** Older generated sheet names — always removed so they never resurface. */
const OBSOLETE_SHEET_NAMES = ['AEGIS Ergänzungen', 'AEGIS Gap Register'];
/** Bump when changing the register layout — lets you verify which build made a file. */
const EXPORTER_BUILD = 'AEGIS-gapregister-de-7';

/** Human-in-the-Loop note appended at the end of the register (German). */
const HUMAN_IN_THE_LOOP_NOTE =
  'Hinweis: KI-gestützte Voranalyse durch AEGIS. Alle Befunde sind im Human-in-the-Loop-Verfahren ' +
  'durch eine fachkundige Person zu prüfen und zu verifizieren. Keine Rechtsberatung.';

// Professional colour palette (ARGB).
const HEADER_FILL = 'FF1F2937'; // dark slate
const SEVERITY_FILL: Record<string, string> = {
  Critical: 'FFC0392B',
  High: 'FFE67E22',
  Medium: 'FFF1C40F',
  Low: 'FF27AE60',
};
const STATUS_FILL: Record<GapStatus, string> = {
  missing: 'FFE74C3C',
  partial: 'FFF39C12',
  covered: 'FF27AE60',
  not_applicable: 'FFBDC3C7',
};

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/**
 * Write the clean, professionally-formatted "AEGIS Gap Register" sheet — always
 * created/replaced, the ONLY place the final findings are written. Also removes
 * the legacy "AEGIS Ergänzungen" sheet so it can never resurface in the demo.
 */
function writeRegisterSheet(workbook: ExcelJS.Workbook, findings: GapFinding[]): void {
  // Remove ANY pre-existing register/legacy sheet — including case/whitespace
  // variants and pre-formatted tables in the uploaded template — so the demo
  // sheet is always built from scratch and findings can never land below a block
  // of inherited (often banded) empty rows.
  const targets = new Set(
    [REGISTER_SHEET_NAME, ...OBSOLETE_SHEET_NAMES].map((n) => n.toLowerCase()),
  );
  for (const ws of [...workbook.worksheets]) {
    if (targets.has(ws.name.trim().toLowerCase())) workbook.removeWorksheet(ws.id);
  }

  const reg = workbook.addWorksheet(REGISTER_SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }], // frozen header row
  });
  // Defensive: a freshly-added sheet is empty, but if anything ever inherits
  // rows, drop them so the header is unambiguously row 1.
  if (reg.rowCount > 0) reg.spliceRows(1, reg.rowCount);

  const severityCol = REGISTER_COLUMNS.findIndex((c) => c.field === 'severity') + 1;
  const statusCol = REGISTER_COLUMNS.findIndex((c) => c.field === 'status') + 1;

  // Header at the explicit first row.
  const header = reg.getRow(1);
  REGISTER_COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.fill = solidFill(HEADER_FILL);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  header.height = 22;
  header.commit();

  // Findings written by EXPLICIT row index (2, 3, …) — never appended after a
  // phantom row count, so the first finding is always row 2.
  findings.forEach((f, fi) => {
    const row = reg.getRow(fi + 2);
    REGISTER_COLUMNS.forEach((c, i) => {
      row.getCell(i + 1).value = c.get(f);
    });
    row.height = 56;
    row.alignment = { vertical: 'top', wrapText: true };
    const sevCell = row.getCell(severityCol);
    sevCell.fill = solidFill(SEVERITY_FILL[f.severity] ?? 'FFFFFFFF');
    sevCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sevCell.alignment = { vertical: 'middle', horizontal: 'center' };
    const statCell = row.getCell(statusCol);
    statCell.fill = solidFill(STATUS_FILL[f.status] ?? 'FFFFFFFF');
    statCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    statCell.alignment = { vertical: 'middle', horizontal: 'center' };
    row.commit();
  });

  // Column widths + filter (only over the header + data rows, before the note).
  REGISTER_COLUMNS.forEach((c, i) => {
    reg.getColumn(i + 1).width = c.wide ? 46 : 16;
  });
  reg.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: REGISTER_COLUMNS.length },
  };

  // Human-in-the-Loop note at the very end (German), one blank row below the
  // data, followed by the KB audit snapshot (version, verification coverage,
  // checksum status) so every exported register is traceable months later.
  const noteRowIdx = findings.length + 3;
  const noteRow = reg.getRow(noteRowIdx);
  noteRow.getCell(1).value = HUMAN_IN_THE_LOOP_NOTE;
  reg.mergeCells(noteRowIdx, 1, noteRowIdx, REGISTER_COLUMNS.length);
  noteRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
  noteRow.getCell(1).alignment = { vertical: 'top', wrapText: true };
  noteRow.height = 40;
  noteRow.commit();

  const auditRowIdx = noteRowIdx + 1;
  const auditRow = reg.getRow(auditRowIdx);
  auditRow.getCell(1).value = auditSnapshotLine('de');
  reg.mergeCells(auditRowIdx, 1, auditRowIdx, REGISTER_COLUMNS.length);
  auditRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
  auditRow.getCell(1).alignment = { vertical: 'top', wrapText: true };
  auditRow.commit();

  // Diagnostic: if you DON'T see this line in the dev terminal when generating a
  // workbook, the server is running stale code — restart it.
  console.info(
    JSON.stringify({
      event: 'aegis_register_written',
      build: EXPORTER_BUILD,
      findings: findings.length,
      headerRow: 1,
      firstDataRow: findings.length > 0 ? 2 : null,
      lastRow: reg.rowCount,
    }),
  );
}

/**
 * Presentation: ensure the workbook opens directly on "AEGIS Gap Register" and
 * that the (often empty) original template sheets — "Gap Register",
 * "Reference & Legend", etc. — are hidden so the demo looks clean.
 */
function presentRegisterFirst(workbook: ExcelJS.Workbook): void {
  const reg = workbook.getWorksheet(REGISTER_SHEET_NAME);
  if (!reg) return;
  for (const ws of workbook.worksheets) {
    ws.state = ws.id === reg.id ? 'visible' : 'hidden';
  }
  const idx = Math.max(0, workbook.worksheets.findIndex((w) => w.id === reg.id));
  workbook.views = [
    { x: 0, y: 0, width: 28000, height: 18000, firstSheet: idx, activeTab: idx, visibility: 'visible' },
  ];
}

const OUTLOOK_SHEET_NAME = 'Regulatorischer Ausblick';

const OUTLOOK_NOTE =
  'Quellenbasierte Behörden-/Aufsichtsmeldungen (Regulatorik-Radar) zu den abgedeckten ' +
  'Regulierungen — wörtlich übernommen, ohne AEGIS-Bewertung. Stand: Generierungszeitpunkt.';

const OUTLOOK_COLUMNS: { header: string; get: (o: OutlookItem) => string; width: number }[] = [
  { header: 'Datum', get: (o) => fmtOutlookDate(o.publishedAt), width: 14 },
  { header: 'Quelle', get: (o) => o.sourceName, width: 18 },
  { header: 'Tags', get: (o) => o.tags.join(', '), width: 22 },
  { header: 'Titel', get: (o) => o.title, width: 50 },
  { header: 'Relevanz', get: (o) => o.relevance, width: 50 },
  { header: 'Link', get: (o) => o.sourceUrl, width: 40 },
];

function fmtOutlookDate(d: Date | null): string {
  return d ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}

/**
 * Optional "Regulatorischer Ausblick" sheet — echoes source-verified radar news
 * for the covered regulations (no AEGIS-generated rating). Added alongside the
 * register; the register stays the active sheet.
 */
function writeOutlookSheet(workbook: ExcelJS.Workbook, items: OutlookItem[]): void {
  for (const ws of [...workbook.worksheets]) {
    if (ws.name.trim().toLowerCase() === OUTLOOK_SHEET_NAME.toLowerCase()) workbook.removeWorksheet(ws.id);
  }
  const sh = workbook.addWorksheet(OUTLOOK_SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });
  if (sh.rowCount > 0) sh.spliceRows(1, sh.rowCount);

  const header = sh.getRow(1);
  OUTLOOK_COLUMNS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.fill = solidFill(HEADER_FILL);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
  header.height = 22;
  header.commit();

  items.forEach((o, i) => {
    const row = sh.getRow(i + 2);
    OUTLOOK_COLUMNS.forEach((c, ci) => {
      row.getCell(ci + 1).value = c.get(o);
    });
    row.height = 40;
    row.alignment = { vertical: 'top', wrapText: true };
    row.commit();
  });

  OUTLOOK_COLUMNS.forEach((c, i) => {
    sh.getColumn(i + 1).width = c.width;
  });
  sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: OUTLOOK_COLUMNS.length } };

  const noteIdx = items.length + 3;
  const noteRow = sh.getRow(noteIdx);
  noteRow.getCell(1).value = OUTLOOK_NOTE;
  sh.mergeCells(noteIdx, 1, noteIdx, OUTLOOK_COLUMNS.length);
  noteRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
  noteRow.getCell(1).alignment = { vertical: 'top', wrapText: true };
  noteRow.height = 36;
  noteRow.commit();
}

/**
 * Fill an uploaded Excel assessment template with validated gap findings:
 *  - validate every finding first; invalid ones are logged and skipped;
 *  - complete empty cells on matching template rows, mapping every recognised
 *    column by header name (not position);
 *  - append rows for requirements the template doesn't list;
 *  - (re)create a fully-populated "AEGIS Gap Register" sheet — the deliverable
 *    column set, every field explicitly mapped.
 *
 * Built on exceljs (in-place edits) so the template's original formatting,
 * column widths, and formulas survive.
 */
/**
 * Resolve which template sheet to fill in place: the named one (exact, then
 * case/whitespace-insensitive), else the first sheet that isn't our generated
 * register/legacy sheet. Returns null only for a worksheet-less workbook. Never
 * throws — the register is produced regardless of the template layout.
 */
function resolveTemplateSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string | undefined,
): ExcelJS.Worksheet | null {
  if (sheetName) {
    const exact = workbook.getWorksheet(sheetName);
    if (exact) return exact;
    const lc = sheetName.trim().toLowerCase();
    const ci = workbook.worksheets.find((w) => w.name.trim().toLowerCase() === lc);
    if (ci) return ci;
  }
  const own = new Set([REGISTER_SHEET_NAME, ...OBSOLETE_SHEET_NAMES]);
  return workbook.worksheets.find((w) => !own.has(w.name)) ?? workbook.worksheets[0] ?? null;
}

export async function fillExcelTemplate(
  originalBuffer: Buffer,
  sheetName: string | undefined,
  findings: GapFinding[],
  options: FillOptions = {},
): Promise<Buffer> {
  const { appendRows = true, fillExisting = true, addMissingSheet = true } = options;

  // ── Validation layer: never write a malformed finding into a cell. ──
  const valid: GapFinding[] = [];
  for (const f of findings) {
    const res = validateGapFinding(f);
    if (res.ok) {
      valid.push(f);
    } else {
      console.warn(
        JSON.stringify({
          event: 'gap_finding_rejected',
          requirementId: f?.requirementId ?? null,
          errors: res.errors,
        }),
      );
    }
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(originalBuffer as unknown as ArrayBuffer);

  // Best-effort, OPTIONAL: also fill the user's own template sheet in place. The
  // demo deliverable is the generated register below, which is produced no matter
  // what — so an unknown/omitted sheet name is auto-resolved and never an error.
  // The agent must never have to ask the user for the sheet name.
  const sheet = resolveTemplateSheet(workbook, sheetName);
  if (sheet) {
    const headers: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      headers[col - 1] = String(cell.text ?? '');
    });
    const columnIdx = resolveColumns(headers);

    const cellAt = (row: ExcelJS.Row, field: string): string =>
      columnIdx[field] ? String(row.getCell(columnIdx[field]).text ?? '') : '';

    const existingKeys = new Set<string>();

    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const rowRegulation = cellAt(row, 'regulation');
      const rowArticle = cellAt(row, 'article');
      const rowReq = cellAt(row, 'requirement');
      if (!rowRegulation && !rowArticle && !rowReq) continue; // blank row

      existingKeys.add(`${rowRegulation}|${rowArticle}`.toLowerCase());
      if (!fillExisting) continue;

      const combined = `${rowRegulation} ${rowArticle} ${rowReq}`.toLowerCase();
      const match = valid.find((f) => {
        const fCombined = `${f.regulation} ${f.article} ${f.requirementTitle}`.toLowerCase();
        return (
          (f.article && combined.includes(f.article.toLowerCase())) ||
          (rowArticle.length > 0 && fCombined.includes(rowArticle.toLowerCase())) ||
          combined.includes(f.requirementId.toLowerCase())
        );
      });
      if (!match) continue;

      // Populate every recognised column for this row — set only when empty so
      // the template author's own content is preserved.
      for (const field of Object.keys(columnIdx)) {
        const getter = FIELD_VALUE[field];
        if (!getter) continue;
        const cell = row.getCell(columnIdx[field]);
        if (String(cell.text ?? '').trim()) continue;
        const value = getter(match);
        if (value) cell.value = value;
      }
    }

    if (appendRows) {
      const missingFindings = valid.filter(
        (f) => !existingKeys.has(`${f.regulation}|${f.article}`.toLowerCase()),
      );
      for (const f of missingFindings) {
        const values: string[] = new Array(Math.max(headers.length, 1)).fill('');
        for (const [field, col] of Object.entries(columnIdx)) {
          const getter = FIELD_VALUE[field];
          if (getter) values[col - 1] = getter(f);
        }
        sheet.addRow(values);
      }
    }
  }

  // The demo deliverable: ALWAYS (re)create the clean, formatted register sheet
  // with only the final selected findings, and drop the legacy sheet. This does
  // not depend on the user's template layout being filled successfully.
  if (addMissingSheet) {
    writeRegisterSheet(workbook, valid);
    presentRegisterFirst(workbook);
  }

  // Optional regulatory outlook — added AFTER presentRegisterFirst so the sheet
  // stays visible (the register remains the active tab). Echo-only.
  if (options.outlook && options.outlook.length > 0) {
    writeOutlookSheet(workbook, options.outlook);
  }

  // Build stamp so any generated file is identifiable. If a downloaded workbook's
  // author is NOT this tag, it was produced by an older build / is a cached file.
  workbook.creator = EXPORTER_BUILD;
  workbook.lastModifiedBy = EXPORTER_BUILD;

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output as ArrayBuffer);
}

export {
  REGISTER_COLUMNS,
  REGISTER_SHEET_NAME,
  OUTLOOK_SHEET_NAME,
  LEGACY_SHEET_NAME,
  STATUS_LABEL,
  SEVERITY_LABEL,
  HUMAN_IN_THE_LOOP_NOTE,
  resolveColumns,
  // From-scratch workbook generation (export engine) reuses the exact register
  // layout the template-fill path produces — one deliverable contract.
  writeRegisterSheet,
};
