import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  fmtDateDe,
  SEVERITY_LABEL,
  STATUS_LABEL,
  type AssessmentReport,
} from './report-model';

/**
 * PDF deliverable via pdf-lib — pure JS, serverless-safe (no headless browser,
 * per the no-Playwright constraint F6). Layout is deliberately simple and
 * robust: manual text wrapping over standard Helvetica (WinAnsi covers German
 * umlauts/ß). Trade-off vs a browser-rendered PDF: no rich typography — but
 * zero native dependencies and deterministic output.
 */

export const PDF_BUILD = 'AEGIS-report-pdf-de-1';

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 56;
const BODY_SIZE = 10;
const LINE_GAP = 4;

const COLOR = {
  dark: rgb(0.12, 0.16, 0.22),
  muted: rgb(0.42, 0.45, 0.5),
  accent: rgb(0.15, 0.39, 0.92),
  severity: {
    Critical: rgb(0.75, 0.22, 0.17),
    High: rgb(0.9, 0.49, 0.13),
    Medium: rgb(0.83, 0.69, 0.06),
    Low: rgb(0.15, 0.68, 0.38),
  } as Record<string, ReturnType<typeof rgb>>,
};

/**
 * WinAnsi cannot encode every Unicode char (e.g. narrow no-break space or
 * typographic arrows that may sit in KB text). Replace what Helvetica can't
 * carry rather than throwing mid-export.
 */
function sanitize(text: string): string {
  return text
    .replace(/[   ]/g, ' ')
    .replace(/[→➔➡]/g, '->')
    .replace(/[✓✔]/g, '[OK]')
    .replace(/[⚠️]/g, '(!)')
    .replace(/[•●]/g, '-')
    .replace(/[„“”]/g, '"')
    .replace(/[‚‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^\x00-\xFF]/g, '?');
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(probe, size) <= maxWidth) {
      line = probe;
    } else {
      if (line) lines.push(line);
      // Hard-break overlong single words.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

type Cursor = { page: PDFPage; y: number };

export async function buildAssessmentPdf(report: AssessmentReport): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(report.meta.title);
  doc.setProducer(PDF_BUILD);
  doc.setCreationDate(report.meta.generatedAt);

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = A4.w - 2 * MARGIN;

  const newPage = (): Cursor => {
    const page = doc.addPage([A4.w, A4.h]);
    return { page, y: A4.h - MARGIN };
  };

  let cur = newPage();

  const ensure = (needed: number) => {
    if (cur.y - needed < MARGIN + 24) cur = newPage();
  };

  const text = (
    t: string,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gapAfter?: number } = {},
  ) => {
    const f = opts.font ?? font;
    const size = opts.size ?? BODY_SIZE;
    for (const line of wrap(f, t, size, width)) {
      ensure(size + LINE_GAP);
      cur.page.drawText(line, { x: MARGIN, y: cur.y - size, size, font: f, color: opts.color ?? COLOR.dark });
      cur.y -= size + LINE_GAP;
    }
    cur.y -= opts.gapAfter ?? 0;
  };

  const rule = () => {
    ensure(10);
    cur.page.drawLine({
      start: { x: MARGIN, y: cur.y - 4 },
      end: { x: A4.w - MARGIN, y: cur.y - 4 },
      thickness: 0.7,
      color: COLOR.muted,
    });
    cur.y -= 12;
  };

  // ── Title page ──
  cur.y -= 140;
  text(report.meta.title, { font: bold, size: 24, gapAfter: 10 });
  text(`Stand: ${fmtDateDe(report.meta.generatedAt)}`, { color: COLOR.muted, size: 12, gapAfter: 4 });
  text(`Geltungsbereich: ${report.meta.scope.join(', ') || '-'}`, { color: COLOR.muted, size: 12, gapAfter: 18 });
  text(report.humanNoteDe, { color: COLOR.muted, size: 9, gapAfter: 8 });
  text(`Verifikationsnachweis: ${report.auditLineDe}`, { color: COLOR.muted, size: 9 });

  // ── Zusammenfassung ──
  cur = newPage();
  text('Zusammenfassung', { font: bold, size: 16, gapAfter: 6 });
  rule();
  text(`Befunde gesamt: ${report.counts.total}`, { gapAfter: 2 });
  text(
    'Nach Schweregrad: ' +
      (['Critical', 'High', 'Medium', 'Low'] as const)
        .map((s) => `${SEVERITY_LABEL[s]}: ${report.counts.bySeverity[s]}`)
        .join('  ·  '),
    { gapAfter: 2 },
  );
  text(
    'Nach Status: ' +
      (['missing', 'partial', 'covered', 'not_applicable'] as const)
        .map((s) => `${STATUS_LABEL[s]}: ${report.counts.byStatus[s]}`)
        .join('  ·  '),
    { gapAfter: 2 },
  );
  text(`Manuell zu prüfen: ${report.counts.manualReview}`, { gapAfter: 12 });

  // ── Findings ──
  text('Befunde', { font: bold, size: 16, gapAfter: 6 });
  rule();
  report.findings.forEach((f, i) => {
    ensure(90);
    text(`${i + 1}. ${f.id} - ${f.requirementTitle || f.gapDescription.slice(0, 70)}`, {
      font: bold,
      size: 12,
      gapAfter: 2,
    });
    text(`${f.regulation} ${f.article}  [${f.requirementId}]`, { color: COLOR.accent, size: 9, gapAfter: 2 });
    text(`Status: ${STATUS_LABEL[f.status]}   Schweregrad: ${SEVERITY_LABEL[f.severity] ?? f.severity}`, {
      color: COLOR.severity[f.severity] ?? COLOR.dark,
      font: bold,
      size: 10,
      gapAfter: 3,
    });
    text(`Feststellung: ${f.gapDescription}`, { gapAfter: 2 });
    text(`Risiko / Auswirkung: ${f.riskImpact}`, { gapAfter: 2 });
    if (f.recommendation.trim()) text(`Empfehlung: ${f.recommendation}`, { gapAfter: 2 });
    text(
      `Nachweis: ${f.citations.length ? `${f.evidence} [${f.citations.join(', ')}]` : f.evidence}`,
      { color: COLOR.muted, size: 9, gapAfter: 2 },
    );
    if (f.manualReview) text('Hinweis: Manuell zu prüfen (Human-in-the-Loop).', { color: COLOR.muted, size: 9, gapAfter: 2 });
    cur.y -= 8;
  });

  // ── Verifikationsanhang ──
  cur = newPage();
  text('Verifikationsanhang - zitierte Anforderungen', { font: bold, size: 16, gapAfter: 6 });
  rule();
  if (report.citedRequirements.length === 0) {
    text('Keine KB-Zitate in den Befunden.', { color: COLOR.muted });
  }
  for (const r of report.citedRequirements) {
    ensure(30);
    text(`${r.id} (${r.ref})`, { font: bold, size: 10, gapAfter: 1 });
    text(r.labelDe, { color: r.verified ? COLOR.severity.Low : COLOR.severity.High, size: 9, gapAfter: 5 });
  }
  cur.y -= 6;
  text(
    'Nachvollziehbare Einzelnachweise je Eintrag: docs/governance/verification-records/ im RegCompass-Repository.',
    { color: COLOR.muted, size: 9, gapAfter: 4 },
  );
  text(report.auditLineDe, { color: COLOR.muted, size: 9 });

  // Page numbers.
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawText(`Seite ${i + 1} / ${pages.length}`, {
      x: A4.w - MARGIN - 70,
      y: MARGIN / 2,
      size: 8,
      font,
      color: COLOR.muted,
    });
  });

  return Buffer.from(await doc.save());
}
