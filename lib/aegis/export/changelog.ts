import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { fmtDateDe } from './report-model';

/**
 * Änderungsprotokoll (change log) — the transparency half of every document
 * improvement. Rows are generated FROM the applied operations, so the log is
 * complete by construction: an edit that is not in the log cannot exist,
 * because the ops list is the single source both the patcher and this builder
 * consume. A regression test additionally diffs original vs improved text and
 * asserts every changed segment appears here.
 */

export type ChangeLogEntry = {
  /** Where the change sits ("Dokumenttext", "Anhang", "Folie 3", …). */
  location: string;
  /** Original wording ('' for pure additions). */
  before: string;
  /** New wording. */
  after: string;
  /** KB requirement id or explicit label ("redaktionell") motivating the change. */
  basis: string;
  /** German severity/binding rationale line. */
  rationale: string;
};

export type ChangeLogMeta = {
  sourceFilename: string;
  improvedFilename: string;
  date: Date;
};

function cell(text: string, opts?: { bold?: boolean; width?: number }): TableCell {
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [
      new Paragraph({ children: [new TextRun({ text, bold: opts?.bold, size: 18 })] }),
    ],
  });
}

function para(text: string, opts?: { bold?: boolean; italic?: boolean; size?: number }): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, bold: opts?.bold, italics: opts?.italic, size: opts?.size ?? 22 })],
  });
}

export async function buildChangeLogDocx(entries: ChangeLogEntry[], meta: ChangeLogMeta): Promise<Buffer> {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell('#', { bold: true, width: 4 }),
      cell('Ort', { bold: true, width: 12 }),
      cell('Vorher', { bold: true, width: 28 }),
      cell('Nachher', { bold: true, width: 28 }),
      cell('Grundlage', { bold: true, width: 12 }),
      cell('Begründung', { bold: true, width: 16 }),
    ],
  });
  const rows = entries.map(
    (e, i) =>
      new TableRow({
        children: [
          cell(String(i + 1)),
          cell(e.location),
          cell(e.before || '—'),
          cell(e.after),
          cell(e.basis),
          cell(e.rationale),
        ],
      }),
  );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.LEFT,
            children: [new TextRun({ text: 'Änderungsprotokoll', bold: true })],
          }),
          para(`Original: ${meta.sourceFilename} (unverändert erhalten)`),
          para(`Überarbeitete Fassung: ${meta.improvedFilename}`),
          para(`Datum: ${fmtDateDe(meta.date)} · Erstellt durch AEGIS (RegCompass)`),
          para(
            `Jede Änderung ist einzeln aufgeführt und auf ihre regulatorische Grundlage zurückführbar. ` +
              `Änderungen ohne KB-Grundlage sind ausdrücklich als redaktionell gekennzeichnet. ` +
              `Die rechtliche Bewertung verbleibt bei den zuständigen Fachexperten.`,
            { italic: true, size: 18 },
          ),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 2, color: 'BBBBBB' },
              bottom: { style: BorderStyle.SINGLE, size: 2, color: 'BBBBBB' },
              left: { style: BorderStyle.SINGLE, size: 2, color: 'BBBBBB' },
              right: { style: BorderStyle.SINGLE, size: 2, color: 'BBBBBB' },
              insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
              insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'DDDDDD' },
            },
            rows: [header, ...rows],
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/**
 * Improved version as a NEW document — used for PDFs, which cannot be patched
 * in place. Plain but honest: extracted text with corrections applied plus the
 * appended section; the cover note states that the original layout could not
 * be preserved.
 */
export async function buildImprovedTextDocx(params: {
  sourceFilename: string;
  paragraphs: string[];
  appendix?: { heading: string; paragraphs: string[] };
  date: Date;
}): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `Überarbeitete Fassung — ${params.sourceFilename}`, bold: true })],
    }),
    para(
      `Hinweis: Das Original ist ein PDF und kann nicht layouterhaltend bearbeitet werden. ` +
        `Diese Fassung enthält den extrahierten Text mit den vorgenommenen Korrekturen; ` +
        `das Original bleibt unverändert erhalten. Stand: ${fmtDateDe(params.date)}.`,
      { italic: true, size: 18 },
    ),
    ...params.paragraphs.filter((t) => t.trim().length > 0).map((t) => para(t)),
  ];
  if (params.appendix) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: params.appendix.heading, bold: true })],
      }),
      ...params.appendix.paragraphs.map((t) => para(t)),
    );
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
