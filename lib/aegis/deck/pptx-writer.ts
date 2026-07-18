import pptxgen from 'pptxgenjs';
import {
  SEVERITY_LABEL_DE,
  STATUS_LABEL_DE,
  type DeckModel,
} from './deck-model';
import { DENSITY, REGCOMPASS_THEME, type DeckDensity, type DeckTheme } from './theme';
import type { Severity } from '../gap-finding';

/**
 * Renders a DeckModel into a real .pptx Buffer using pptxgenjs (pure JS, no
 * native binaries — serverless-safe). All content comes from the DeckModel,
 * which is itself built only from structured findings + KB (see deck-model.ts).
 *
 * Visual system: two slide masters (a dark title master + a light content master
 * with a brand top-bar, footer and page number), one shared section header, and
 * one table helper that gives every table consistent padding, zebra striping and
 * a dark header row. Content text is never altered here.
 *
 * All visual constants come from a DeckTheme (theme.ts) so client-branded decks
 * are a theme object, not a writer fork. `density` trades content per slide for
 * guaranteed fit — deck-lint.ts drives the compact retry.
 */

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];

// Page geometry (LAYOUT_WIDE = 13.33 × 7.5 in).
const PW = 13.33;
const MX = 0.55; // left/right margin
const CW = PW - 2 * MX; // content width
const CONTENT_Y = 1.6; // first content baseline (below the header divider)

const MASTER_CONTENT = 'AEGIS_CONTENT';
const MASTER_TITLE = 'AEGIS_TITLE';

type Slide = ReturnType<pptxgen['addSlide']>;

export type BuildPptxOptions = {
  theme?: DeckTheme;
  density?: DeckDensity;
};

export type BuildPptxResult = {
  buffer: Buffer;
  slideCount: number;
  density: DeckDensity;
};

type Ctx = {
  t: DeckTheme;
  d: (typeof DENSITY)[DeckDensity];
};

function defineMasters(pptx: pptxgen, { t }: Ctx): void {
  pptx.defineSlideMaster({
    title: MASTER_CONTENT,
    background: { color: t.paper },
    objects: [
      { rect: { x: 0, y: 0, w: PW, h: 0.14, fill: { color: t.brand } } }, // branded top edge
      { line: { x: MX, y: 7.0, w: CW, h: 0, line: { color: t.border, width: 1 } } },
      {
        text: {
          text: t.footer,
          options: { x: MX, y: 7.05, w: CW - 0.8, h: 0.3, fontSize: 8, color: t.muted, fontFace: t.font, align: 'left', valign: 'middle' },
        },
      },
    ],
    slideNumber: { x: PW - MX - 0.7, y: 7.05, w: 0.7, h: 0.3, fontSize: 9, color: t.muted, fontFace: t.font, align: 'right' },
  });

  pptx.defineSlideMaster({
    title: MASTER_TITLE,
    background: { color: t.slate },
    objects: [
      { rect: { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: t.brand } } }, // left accent rail
      { rect: { x: 10.7, y: 5.7, w: 2.63, h: 1.8, fill: { color: t.brand, transparency: 88 } } }, // faint corner block
    ],
  });
}

/** Standard content header: kicker (brand), German title, brand divider. */
function sectionHeader(slide: Slide, kicker: string, title: string, { t }: Ctx): void {
  slide.addText(kicker.toUpperCase(), { x: MX, y: 0.42, w: CW, h: 0.3, fontSize: 11, color: t.brandDeep, bold: true, charSpacing: 2, fontFace: t.font });
  slide.addText(title, { x: MX, y: 0.7, w: CW, h: 0.6, fontSize: 27, color: t.ink, bold: true, fontFace: t.font });
  slide.addShape('line', { x: MX, y: 1.36, w: CW, h: 0, line: { color: t.brand, width: 2 } });
}

function emptyNote(slide: Slide, text: string, { t }: Ctx): void {
  slide.addText(text, { x: MX, y: 3.2, w: CW, h: 0.6, fontSize: 14, color: t.muted, italic: true, fontFace: t.font });
}

const SEV_LABEL = (s: Severity) => SEVERITY_LABEL_DE[s];

/** German titles of the content sections, in deck order — drives the agenda slide. */
export function agendaEntries(model: DeckModel): string[] {
  const entries = [
    'Management-Zusammenfassung',
    'Geltungsbereich & Anwendungsfall',
    'Risikoklassifizierung',
  ];
  if (model.outlook.length > 0) entries.push('Regulatorischer Ausblick');
  entries.push(
    'Zentrale Ergebnisse',
    'Schweregrad-Übersicht',
    'Regulatorische Pflichten',
    'Empfohlene Maßnahmen',
    'Maßnahmenplan',
    'Prüfmethodik & Verifizierung',
    'Quellen & Nachweise',
  );
  return entries;
}

export async function buildPptxBuffer(model: DeckModel, opts: BuildPptxOptions = {}): Promise<BuildPptxResult> {
  const ctx: Ctx = { t: opts.theme ?? REGCOMPASS_THEME, d: DENSITY[opts.density ?? 'normal'] };
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = ctx.t.author;
  pptx.company = ctx.t.company;
  pptx.title = model.title;
  defineMasters(pptx, ctx);

  titleSlide(pptx, model, ctx);
  agendaSlide(pptx, model, ctx);
  executiveSlide(pptx, model, ctx);
  scopeSlide(pptx, model, ctx);
  riskSlide(pptx, model, ctx);
  if (model.outlook.length > 0) outlookSlide(pptx, model, ctx); // opt-in regulatory radar
  findingsSlide(pptx, model, ctx);
  heatmapSlide(pptx, model, ctx);
  obligationsSlide(pptx, model, ctx);
  controlsSlide(pptx, model, ctx);
  roadmapSlide(pptx, model, ctx);
  methodSlide(pptx, model, ctx);
  sourcesSlide(pptx, model, ctx);

  const out = await pptx.write({ outputType: 'nodebuffer' });
  const slideCount = 12 + (model.outlook.length > 0 ? 1 : 0);
  return { buffer: out as Buffer, slideCount, density: opts.density ?? 'normal' };
}

/** A content slide with the shared master + header already applied. */
function contentSlide(pptx: pptxgen, kicker: string, title: string, ctx: Ctx): Slide {
  const slide = pptx.addSlide({ masterName: MASTER_CONTENT });
  sectionHeader(slide, kicker, title, ctx);
  return slide;
}

// ───────────────────────── slides ─────────────────────────

function titleSlide(pptx: pptxgen, m: DeckModel, { t }: Ctx): void {
  const slide = pptx.addSlide({ masterName: MASTER_TITLE });
  slide.addText(t.brandLine, { x: 0.7, y: 1.95, w: 11.5, h: 0.4, fontSize: 15, color: t.brand, bold: true, charSpacing: 3, fontFace: t.font });
  slide.addText(m.title, { x: 0.7, y: 2.45, w: 11.6, h: 1.5, fontSize: 40, color: t.paper, bold: true, fontFace: t.font, valign: 'top', fit: 'shrink' });
  slide.addText(m.subtitle, { x: 0.72, y: 3.95, w: 11.6, h: 0.6, fontSize: 20, color: 'D1D5DB', fontFace: t.font, fit: 'shrink' });
  slide.addShape('line', { x: 0.74, y: 4.7, w: 3.6, h: 0, line: { color: t.brand, width: 2.5 } });
  slide.addText(`Erstellt am ${m.generatedAtLabel} · ${t.company}`, { x: 0.7, y: 4.9, w: 11.6, h: 0.4, fontSize: 12, color: '9CA3AF', fontFace: t.font });
  slide.addText('Maschinell erzeugte Zusammenfassung auf Basis strukturierter Bewertungsergebnisse. Keine Rechtsberatung.', {
    x: 0.7, y: 6.75, w: 11.6, h: 0.5, fontSize: 9, color: '9CA3AF', italic: true, fontFace: t.font,
  });
}

function agendaSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = contentSlide(pptx, 'Agenda', 'Inhalt', ctx);
  const entries = agendaEntries(m);
  const mid = Math.ceil(entries.length / 2);
  const columns: [string[], number][] = [
    [entries.slice(0, mid), MX],
    [entries.slice(mid), MX + CW / 2 + 0.2],
  ];
  for (const [items, x] of columns) {
    slide.addText(
      items.map((title, i) => ({
        text: `${String(entries.indexOf(title) + 1).padStart(2, '0')}   ${title}`,
        options: { fontSize: 16, color: t.ink, breakLine: true, paraSpaceAfter: 14, fontFace: t.font, bold: false },
      })),
      { x, y: CONTENT_Y + 0.3, w: CW / 2 - 0.3, h: 4.8, valign: 'top', fit: 'shrink' },
    );
  }
}

function executiveSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Executive Summary', 'Management-Zusammenfassung', ctx);

  // Headline in a tinted band for emphasis.
  slide.addShape('roundRect', { x: MX, y: CONTENT_Y, w: CW, h: 0.62, fill: { color: t.card }, line: { color: t.border, width: 1 }, rectRadius: 0.06 });
  slide.addText(m.executive.headline, { x: MX + 0.2, y: CONTENT_Y, w: CW - 0.4, h: 0.62, fontSize: 15, color: t.slate, bold: true, valign: 'middle', fontFace: t.font, fit: 'shrink' });

  // Severity stat tiles (left), donut (right).
  const tileY = 2.55;
  SEVERITIES.forEach((s, i) => {
    const x = MX + i * 2.05;
    slide.addShape('roundRect', { x, y: tileY, w: 1.85, h: 1.15, fill: { color: t.severityTint[s] }, line: { color: t.severity[s], width: 1 }, rectRadius: 0.08 });
    slide.addText(String(m.executive.bySeverity[s]), { x, y: tileY + 0.12, w: 1.85, h: 0.6, fontSize: 30, bold: true, color: t.severity[s], align: 'center', fontFace: t.font });
    slide.addText(SEV_LABEL(s), { x, y: tileY + 0.74, w: 1.85, h: 0.3, fontSize: 11, color: t.slate, align: 'center', fontFace: t.font });
  });

  if (m.executive.totalFindings > 0) {
    slide.addChart('doughnut', [{
      name: 'Schweregrad',
      labels: SEVERITIES.map(SEV_LABEL),
      values: SEVERITIES.map((s) => m.executive.bySeverity[s]),
    }], {
      x: 9.3, y: 1.75, w: 3.5, h: 3.4,
      chartColors: SEVERITIES.map((s) => t.severity[s]),
      showLegend: true, legendPos: 'b', legendFontFace: t.font, legendFontSize: 10,
      showValue: true, dataLabelColor: t.paper, dataLabelFontFace: t.font, dataLabelFontBold: true, holeSize: 62,
    });
  }

  // Top risks.
  slide.addText('Wesentliche Risiken', { x: MX, y: 3.95, w: 8.5, h: 0.3, fontSize: 13, bold: true, color: t.brandDeep, fontFace: t.font });
  if (m.executive.topRisks.length === 0) {
    slide.addText('Keine kritischen oder hohen Findings.', { x: MX, y: 4.3, w: 8.5, h: 0.3, fontSize: 12, color: t.muted, italic: true, fontFace: t.font });
  } else {
    slide.addText(
      m.executive.topRisks.map((f) => ({
        text: `${f.regulation} ${f.article} — ${f.title} (${SEV_LABEL(f.severity)})`,
        options: { bullet: { code: '2022' }, color: t.ink, fontSize: d.bulletFont, breakLine: true, paraSpaceAfter: 7, fontFace: t.font },
      })),
      { x: MX, y: 4.3, w: 8.5, h: 2.5, valign: 'top', fit: 'shrink' },
    );
  }
}

function scopeSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = contentSlide(pptx, 'Scope / Use Case', 'Geltungsbereich & Anwendungsfall', ctx);
  slide.addShape('roundRect', { x: MX, y: CONTENT_Y, w: CW, h: 5.0, fill: { color: t.card }, line: { color: t.border, width: 1 }, rectRadius: 0.06 });
  slide.addText(m.scope, { x: MX + 0.35, y: CONTENT_Y + 0.3, w: CW - 0.7, h: 4.4, fontSize: 15, color: t.ink, valign: 'top', lineSpacingMultiple: 1.25, fontFace: t.font, fit: 'shrink' });
}

function riskSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = contentSlide(pptx, 'Risk Classification', 'Risikoklassifizierung', ctx);
  if (!m.riskClassification) {
    emptyNote(slide, 'Keine strukturierte Risikoklassifizierung übergeben.', ctx);
    return;
  }
  const rc = m.riskClassification;
  slide.addShape('roundRect', { x: MX, y: CONTENT_Y, w: 4.4, h: 1.25, fill: { color: 'EAF6FE' }, line: { color: t.brand, width: 1.5 }, rectRadius: 0.08 });
  slide.addText('RISIKOSTUFE', { x: MX + 0.25, y: CONTENT_Y + 0.12, w: 3.9, h: 0.3, fontSize: 10, color: t.brandDeep, bold: true, charSpacing: 1, fontFace: t.font });
  slide.addText(rc.tier, { x: MX + 0.25, y: CONTENT_Y + 0.42, w: 3.9, h: 0.7, fontSize: 24, bold: true, color: t.slate, valign: 'middle', fontFace: t.font, fit: 'shrink' });

  slide.addText('Begründung', { x: MX, y: 3.15, w: CW, h: 0.3, fontSize: 13, bold: true, color: t.brandDeep, fontFace: t.font });
  slide.addText(rc.rationale || '—', { x: MX, y: 3.5, w: CW, h: 1.9, fontSize: 14, color: t.ink, valign: 'top', lineSpacingMultiple: 1.2, fontFace: t.font, fit: 'shrink' });
  if (rc.drivenBy.length) {
    slide.addText('Maßgebliche Anforderungen', { x: MX, y: 5.5, w: CW, h: 0.3, fontSize: 12, bold: true, color: t.brandDeep, fontFace: t.font });
    slide.addText(rc.drivenBy.join('   ·   '), { x: MX, y: 5.8, w: CW, h: 0.6, fontSize: 12, color: t.slate, fontFace: t.font, fit: 'shrink' });
  }
}

function findingsSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Key Findings', 'Zentrale Ergebnisse', ctx);
  if (m.findings.length === 0) {
    emptyNote(slide, 'Keine Findings — diese Zusammenfassung basiert auf den Anforderungen im Geltungsbereich.', ctx);
    return;
  }
  const shown = m.findings.slice(0, d.findingsRows);
  const header = ['Reg. / Art.', 'Anforderung', 'Status', 'Schwere', 'Lücke'].map((h) => headerCell(h, ctx));
  const body = shown.map((f) => [
    cell(`${f.regulation}\n${f.article}`, ctx, { fontSize: d.tableFont, color: t.slate, bold: true }),
    cell(f.title, ctx, { fontSize: d.tableFont }),
    cell(STATUS_LABEL_DE[f.status], ctx, { fontSize: d.tableFont, align: 'center' }),
    cell(SEV_LABEL(f.severity), ctx, { fontSize: d.tableFont, align: 'center', bold: true, color: t.paper, fill: { color: t.severity[f.severity] } }),
    cell(f.gap, ctx, { fontSize: d.tableBodyFont, color: '374151' }),
  ]);
  dataTable(slide, header, body, { x: MX, y: CONTENT_Y, w: CW, colW: [1.5, 3.4, 1.2, 1.1, CW - 7.2] }, ctx);
  if (m.findings.length > shown.length) {
    slide.addText(`+ ${m.findings.length - shown.length} weitere Findings — vollständige Liste im Export (Excel/Word).`, {
      x: MX, y: 6.55, w: CW, h: 0.3, fontSize: 9, italic: true, color: t.muted, fontFace: t.font,
    });
  }
}

function heatmapSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = contentSlide(pptx, 'Severity Overview', 'Schweregrad-Übersicht / Heatmap', ctx);
  if (m.heatmap.length === 0) {
    emptyNote(slide, 'Keine Findings für eine Heatmap vorhanden.', ctx);
    return;
  }
  const header = [headerCell('Regulierung', ctx), ...SEVERITIES.map((s) => headerCell(SEV_LABEL(s), ctx)), headerCell('Σ', ctx)];
  const body = m.heatmap.map((r) => [
    cell(r.regulation, ctx, { fontSize: 11, bold: true, color: t.slate }),
    ...SEVERITIES.map((s) => cell(String(r.counts[s]), ctx, { align: 'center', bold: true, color: r.counts[s] ? t.severity[s] : t.muted, fill: { color: r.counts[s] ? t.severityTint[s] : t.paper }, fontSize: 12 })),
    cell(String(r.total), ctx, { align: 'center', bold: true, fontSize: 12 }),
  ]);
  dataTable(slide, header, body, { x: MX, y: CONTENT_Y, w: 6.7, colW: [2.3, 1.0, 1.0, 1.0, 1.0, 0.4] }, ctx);

  slide.addChart('bar', [{
    name: 'Findings',
    labels: SEVERITIES.map(SEV_LABEL),
    values: SEVERITIES.map((s) => m.executive.bySeverity[s]),
  }], {
    x: 7.7, y: 1.7, w: 5.0, h: 4.7, barDir: 'col', chartColors: SEVERITIES.map((s) => t.severity[s]),
    showLegend: false, showValue: true, dataLabelColor: t.ink, dataLabelFontFace: t.font, dataLabelFontBold: true,
    catAxisLabelColor: t.ink, catAxisLabelFontFace: t.font, catAxisLabelFontSize: 11, valAxisHidden: true,
  });
}

function obligationsSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Regulatory Obligations', 'Regulatorische Pflichten', ctx);
  if (m.obligations.length === 0) {
    emptyNote(slide, 'Keine auflösbaren Anforderungen im Geltungsbereich.', ctx);
    return;
  }
  const header = ['Reg. / Art.', 'Pflicht', 'Bindung', 'Relevanz', 'Quelle'].map((h) => headerCell(h, ctx));
  const body = m.obligations.map((o) => [
    cell(`${o.regulation}\n${o.article}`, ctx, { fontSize: d.tableFont, bold: true, color: t.slate }),
    cell(`${o.title}\n${o.requirementId}`, ctx, { fontSize: d.tableFont }),
    cell(o.bindingLevel, ctx, { fontSize: d.tableFont, align: 'center' }),
    cell(o.relevance, ctx, { fontSize: d.tableFont, align: 'center' }),
    cell(o.sourceUrl || o.sourceFile || '—', ctx, { fontSize: 8, color: t.brandDeep }),
  ]);
  dataTable(slide, header, body, { x: MX, y: CONTENT_Y, w: CW, colW: [1.5, 4.6, 1.6, 1.4, CW - 9.1] }, ctx);
}

function controlsSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Recommended Controls', 'Empfohlene Maßnahmen', ctx);
  if (m.controls.length === 0) {
    emptyNote(slide, 'Keine Maßnahmen in der Wissensbasis für die Anforderungen hinterlegt.', ctx);
    return;
  }
  const header = ['Reg. / Art.', 'Maßnahme', 'Priorität'].map((h) => headerCell(h, ctx));
  const body = m.controls.map((c) => [
    cell(`${c.regulation} ${c.article}`, ctx, { fontSize: d.tableFont, bold: true, color: t.slate }),
    cell(c.steps.length ? `${c.action}\n• ${c.steps.join('\n• ')}` : c.action, ctx, { fontSize: d.tableFont }),
    cell(c.priority, ctx, { fontSize: d.tableFont, align: 'center' }),
  ]);
  dataTable(slide, header, body, { x: MX, y: CONTENT_Y, w: CW, colW: [2.0, CW - 3.5, 1.5] }, ctx);
}

function roadmapSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Roadmap / Next Steps', 'Maßnahmenplan', ctx);
  if (m.roadmap.length === 0) {
    emptyNote(slide, 'Keine offenen Maßnahmen — keine Roadmap erforderlich.', ctx);
    return;
  }
  const gap = 0.25;
  const colW = (CW - gap * (m.roadmap.length - 1)) / m.roadmap.length;
  m.roadmap.forEach((phase, i) => {
    const x = MX + i * (colW + gap);
    // Phase header pill + a light card body for the column.
    slide.addShape('roundRect', { x, y: CONTENT_Y, w: colW, h: 0.55, fill: { color: t.slate }, rectRadius: 0.06 });
    slide.addText(phase.phase, { x: x + 0.12, y: CONTENT_Y, w: colW - 0.24, h: 0.55, fontSize: 12, bold: true, color: t.paper, valign: 'middle', fontFace: t.font, fit: 'shrink' });
    slide.addShape('roundRect', { x, y: CONTENT_Y + 0.62, w: colW, h: 4.55, fill: { color: t.card }, line: { color: t.border, width: 1 }, rectRadius: 0.06 });
    slide.addText(
      phase.items.map((tx) => ({ text: tx, options: { bullet: { code: '2022' }, fontSize: d.roadmapFont, color: t.ink, breakLine: true, paraSpaceAfter: 7, fontFace: t.font } })),
      { x: x + 0.18, y: CONTENT_Y + 0.78, w: colW - 0.36, h: 4.25, valign: 'top', fit: 'shrink' },
    );
  });
}

function outlookSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = pptx.addSlide({ masterName: MASTER_CONTENT });
  sectionHeader(slide, 'Regulatory Outlook', 'Regulatorischer Ausblick', ctx);
  slide.addText('Quellenbasierte Behörden-/Aufsichtsmeldungen zu den abgedeckten Regulierungen — ohne AEGIS-Bewertung.', {
    x: MX, y: 1.42, w: CW, h: 0.3, fontSize: 10, color: t.muted, italic: true, fontFace: t.font,
  });
  if (m.outlook.length === 0) {
    emptyNote(slide, 'Keine aktuellen Meldungen für die abgedeckten Regulierungen.', ctx);
    return;
  }
  slide.addText(
    m.outlook.flatMap((o) => [
      { text: o.title, options: { bullet: { code: '2022' }, fontSize: 12, color: t.ink, bold: true, breakLine: true, fontFace: t.font } },
      { text: `${o.source} · ${o.dateLabel}${o.relevance ? `  —  ${o.relevance}` : ''}`, options: { fontSize: 10, color: t.slate, breakLine: true, indentLevel: 1, fontFace: t.font } },
      { text: o.url, options: { fontSize: 9, color: t.brandDeep, breakLine: true, indentLevel: 1, paraSpaceAfter: 10, fontFace: t.font } },
    ]),
    { x: MX, y: 1.85, w: CW, h: 5.0, valign: 'top', fit: 'shrink' },
  );
}

/**
 * "Prüfmethodik & Verifizierung" — the client-facing audit-chain slide. Every
 * statement here is a property of the pipeline itself (deck-model contract,
 * KB verification process, deterministic severity, delivery lint) — no claims
 * about the specific assessment beyond the auditLine, which carries the live
 * KB verification snapshot.
 */
function methodSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t } = ctx;
  const slide = contentSlide(pptx, 'Methodology & Verification', 'Prüfmethodik & Verifizierung', ctx);

  const points: [string, string][] = [
    ['Kuratierte Wissensbasis', 'Alle regulatorischen Aussagen stammen aus der kuratierten Wissensbasis; jeder Eintrag ist gegen den Primärquelltext geprüft (zweifach unabhängige Verifikation, Prüfpfad je Eintrag dokumentiert).'],
    ['Keine erfundenen Inhalte', 'Dieses Deck wird ausschließlich aus strukturierten Bewertungsergebnissen aufgebaut. Nicht auflösbare Verweise werden verworfen statt ergänzt; das Sprachmodell liefert keine regulatorische Prosa.'],
    ['Deterministische Schweregrade', 'Risiko- und Schweregrad-Einstufungen werden regelbasiert aus den kuratierten Klassifikationen abgeleitet — nie vom Sprachmodell vergeben.'],
    ['Strukturprüfung vor Auslieferung', 'Jede generierte Präsentation durchläuft vor der Auslieferung eine automatische Struktur- und Layoutprüfung (Zitate auflösbar, Inhalte innerhalb der Folien, keine leeren Pflichtfelder).'],
    ['Transparente Quellen', 'Die Folie „Quellen & Nachweise" weist für jede Anforderung Herkunft und Verifikationsstatus einzeln aus. Es gilt: Erläuterung, keine Rechtsberatung.'],
  ];

  points.forEach(([head, body], i) => {
    const y = CONTENT_Y + i * 1.02;
    slide.addShape('roundRect', { x: MX, y, w: 0.34, h: 0.34, fill: { color: t.brand }, rectRadius: 0.05 });
    slide.addText(String(i + 1), { x: MX, y, w: 0.34, h: 0.34, fontSize: 12, bold: true, color: t.paper, align: 'center', valign: 'middle', fontFace: t.font });
    slide.addText(head, { x: MX + 0.5, y: y - 0.03, w: CW - 0.5, h: 0.32, fontSize: 13, bold: true, color: t.slate, fontFace: t.font });
    slide.addText(body, { x: MX + 0.5, y: y + 0.28, w: CW - 0.5, h: 0.62, fontSize: 10.5, color: t.ink, valign: 'top', fontFace: t.font, fit: 'shrink' });
  });

  slide.addText(m.auditLine, { x: MX, y: 6.65, w: CW, h: 0.3, fontSize: 9, italic: true, color: t.slate, fontFace: t.font });
}

function sourcesSlide(pptx: pptxgen, m: DeckModel, ctx: Ctx): void {
  const { t, d } = ctx;
  const slide = contentSlide(pptx, 'Sources / Audit Trail', 'Quellen & Nachweise', ctx);
  if (m.sources.length === 0) {
    emptyNote(slide, 'Keine Quellen.', ctx);
  } else {
    const shown = m.sources.slice(0, d.sourcesRows);
    slide.addText(
      shown.map((s) => ({
        text: `${s.requirementId} — ${s.regulation} ${s.article}${s.url ? `  ·  ${s.url}` : s.pdf ? `  ·  ${s.pdf}` : ''}  ·  ${s.provenance}  ·  ${s.verification}`,
        options: { bullet: { code: '2022' }, fontSize: d.sourcesFont, color: t.ink, breakLine: true, paraSpaceAfter: 5, fontFace: t.font },
      })),
      { x: MX, y: CONTENT_Y, w: CW, h: 4.7, valign: 'top', fit: 'shrink' },
    );
    if (m.sources.length > shown.length) {
      slide.addText(`+ ${m.sources.length - shown.length} weitere Quellen im vollständigen Export.`, {
        x: MX, y: 6.35, w: CW, h: 0.25, fontSize: 9, italic: true, color: t.muted, fontFace: t.font,
      });
    }
  }
  // KB audit snapshot — version, verification coverage, checksum status.
  slide.addText(m.auditLine, {
    x: MX, y: CONTENT_Y + 4.8, w: CW, h: 0.4,
    fontSize: 9, italic: true, color: t.slate, fontFace: t.font, valign: 'bottom',
  });
}

// ───────────────────────── table helpers ─────────────────────────

type CellOpts = { fontSize?: number; bold?: boolean; color?: string; align?: 'left' | 'center' | 'right'; fill?: { color: string } };
type TableCell = ReturnType<typeof cell>;

function cell(text: string, { t }: Ctx, opts: CellOpts = {}) {
  return {
    text,
    options: {
      fontSize: opts.fontSize ?? 10,
      bold: opts.bold,
      color: opts.color ?? t.ink,
      align: opts.align ?? ('left' as const),
      fill: opts.fill,
      valign: 'middle' as const,
      fontFace: t.font,
      margin: [4, 7, 4, 7] as [number, number, number, number], // breathing room inside cells
    },
  };
}

function headerCell(text: string, { t }: Ctx) {
  return {
    text,
    options: {
      fontSize: 10,
      bold: true,
      color: t.paper,
      fill: { color: t.slate },
      align: 'left' as const,
      valign: 'middle' as const,
      fontFace: t.font,
      margin: [5, 7, 5, 7] as [number, number, number, number],
    },
  };
}

/** Render a table with zebra striping (explicit cell fills are preserved). */
function dataTable(
  slide: Slide,
  header: TableCell[],
  body: TableCell[][],
  opts: { x: number; y: number; w: number; colW: number[] },
  { t }: Ctx,
): void {
  const striped = body.map((row, ri) =>
    row.map((c) => ({
      ...c,
      options: { ...c.options, fill: c.options.fill ?? { color: ri % 2 === 0 ? t.paper : t.rowAlt } },
    })),
  );
  slide.addTable([header, ...striped], {
    x: opts.x, y: opts.y, w: opts.w, colW: opts.colW,
    border: { type: 'solid', color: t.border, pt: 0.5 },
    valign: 'middle', autoPage: false, fontFace: t.font,
  });
}
