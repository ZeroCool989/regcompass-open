import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  fmtDateDe,
  SEVERITY_LABEL,
  STATUS_LABEL,
  type AssessmentReport,
} from './report-model';
import type { GapFinding } from '../gap-finding';

/**
 * Word deliverable: the assessment as a structured German DOCX — title page,
 * Zusammenfassung, one section per finding, Verifikationsanhang. Deterministic
 * layout from the report model; no model calls.
 */

export const DOCX_BUILD = 'AEGIS-report-docx-de-1';

const SEVERITY_SHADE: Record<string, string> = {
  Critical: 'C0392B',
  High: 'E67E22',
  Medium: 'F1C40F',
  Low: '27AE60',
};

function h1(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 } });
}

function h2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 110 } });
}

function p(text: string, opts?: { italic?: boolean; bold?: boolean; size?: number }): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text, italics: opts?.italic, bold: opts?.bold, size: opts?.size ?? 22 }),
    ],
    spacing: { after: 80 },
  });
}

function kvRow(k: string, v: string, shade?: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 28, type: WidthType.PERCENTAGE },
        children: [p(k, { bold: true })],
      }),
      new TableCell({
        width: { size: 72, type: WidthType.PERCENTAGE },
        shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
        children: [p(v)],
      }),
    ],
  });
}

function findingSection(f: GapFinding, index: number): (Paragraph | Table)[] {
  const rows: TableRow[] = [
    kvRow('Regulierung / Artikel', `${f.regulation} — ${f.article}`),
    kvRow('Anforderung', `${f.requirementTitle} [${f.requirementId}]`),
    kvRow('Status', STATUS_LABEL[f.status]),
    kvRow('Schweregrad', SEVERITY_LABEL[f.severity] ?? f.severity, SEVERITY_SHADE[f.severity]),
    kvRow('Feststellung', f.gapDescription),
    kvRow('Risiko / Auswirkung', f.riskImpact),
    kvRow('Policy-Auszug', f.policyExcerpt),
  ];
  if (f.recommendation.trim()) rows.push(kvRow('Empfehlung', f.recommendation));
  rows.push(kvRow('Nachweis / Quelle', f.citations.length ? `${f.evidence} [${f.citations.join(', ')}]` : f.evidence));
  rows.push(kvRow('Begründung', f.reason));
  if (f.manualReview) rows.push(kvRow('Hinweis', 'Manuell zu prüfen (Human-in-the-Loop).'));

  return [
    h2(`${index + 1}. ${f.id}: ${f.requirementTitle || f.gapDescription.slice(0, 80)}`),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
        left: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
        right: { style: BorderStyle.SINGLE, size: 2, color: 'D1D5DB' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
        insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
      },
      rows,
    }),
  ];
}

/** Build the DOCX buffer for the assessment report. */
export async function buildAssessmentDocx(report: AssessmentReport): Promise<Buffer> {
  const summaryRows: TableRow[] = [
    kvRow('Erstellt am', fmtDateDe(report.meta.generatedAt)),
    kvRow('Geltungsbereich', report.meta.scope.join(', ') || '—'),
    kvRow('Befunde gesamt', String(report.counts.total)),
    kvRow(
      'Nach Schweregrad',
      (['Critical', 'High', 'Medium', 'Low'] as const)
        .map((s) => `${SEVERITY_LABEL[s]}: ${report.counts.bySeverity[s]}`)
        .join(' · '),
    ),
    kvRow(
      'Nach Status',
      (['missing', 'partial', 'covered', 'not_applicable'] as const)
        .map((s) => `${STATUS_LABEL[s]}: ${report.counts.byStatus[s]}`)
        .join(' · '),
    ),
    kvRow('Manuell zu prüfen', String(report.counts.manualReview)),
  ];

  const verificationParagraphs: Paragraph[] = report.citedRequirements.map(
    (r) =>
      new Paragraph({
        bullet: { level: 0 },
        children: [
          new TextRun({ text: `${r.id} `, bold: true, size: 20 }),
          new TextRun({ text: `(${r.ref}) — ${r.labelDe}`, size: 20 }),
        ],
      }),
  );

  const doc = new Document({
    creator: DOCX_BUILD,
    title: report.meta.title,
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: report.auditLineDe, italics: true, size: 14 })],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            text: report.meta.title,
            heading: HeadingLevel.TITLE,
            spacing: { before: 1200, after: 200 },
          }),
          p(`Stand: ${fmtDateDe(report.meta.generatedAt)}`, { italic: true }),
          p(report.humanNoteDe, { italic: true, size: 18 }),
          h1('Zusammenfassung'),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: summaryRows }),
          h1('Befunde'),
          ...report.findings.flatMap((f, i) => findingSection(f, i)),
          h1('Verifikationsanhang — zitierte Anforderungen'),
          ...(verificationParagraphs.length
            ? verificationParagraphs
            : [p('Keine KB-Zitate in den Befunden.', { italic: true })]),
          p(
            'Nachvollziehbare Einzelnachweise je Eintrag: docs/governance/verification-records/ im RegCompass-Repository.',
            { italic: true, size: 18 },
          ),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
