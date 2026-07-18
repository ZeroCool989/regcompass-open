import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

/**
 * Surgical DOCX improvement — the Word twin of deck/pptx-improve.ts. The
 * client's document is never round-tripped through an object model: we unzip
 * the OPC container, patch text runs (`<w:t>`) inside `word/document.xml`, and
 * rezip. Styles, numbering, headers/footers, images, themes and metadata stay
 * byte-identical by construction because their parts are never touched.
 *
 * Two operations:
 *  - replaceText: swap an exact text snippet for KB-grounded replacement text
 *    (the caller guarantees the anti-hallucination contract);
 *  - appendSection: add a clearly-labeled section (heading + paragraphs) at
 *    the end of the body, BEFORE the final sectPr so page setup survives.
 *
 * Limitation (same as the PPTX patcher, documented): a find-text that Word
 * split across multiple runs (e.g. by spell-check markers) will not match —
 * such ops are reported in `skipped`, never silently dropped.
 */

export type DocxReplaceOp = {
  type: 'replaceText';
  find: string;
  replace: string;
};

export type DocxAppendSectionOp = {
  type: 'appendSection';
  heading: string;
  paragraphs: string[];
};

export type DocxImproveOp = DocxReplaceOp | DocxAppendSectionOp;

export type DocxImproveResult = {
  buffer: Buffer;
  replacements: number;
  appendedParagraphs: number;
  /** replaceText ops whose find-text was not found (run-split or absent). */
  skipped: DocxReplaceOp[];
};

const W_RUN_RE = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function replaceInDocumentXml(xml: string, find: string, replace: string): [string, number] {
  let count = 0;
  const out = xml.replace(W_RUN_RE, (_all, open: string, inner: string, close: string) => {
    const decoded = decodeEntities(inner);
    if (!decoded.includes(find)) return `${open}${inner}${close}`;
    const parts = decoded.split(find);
    count += parts.length - 1;
    // xml:space="preserve" keeps leading/trailing spaces of the edited run.
    const openPreserved = open.includes('xml:space')
      ? open
      : open.replace('<w:t', '<w:t xml:space="preserve"');
    return `${openPreserved}${encodeEntities(parts.join(replace))}${close}`;
  });
  return [out, count];
}

function paragraphXml(text: string, opts?: { bold?: boolean; heading?: boolean }): string {
  const rPr = opts?.bold || opts?.heading ? '<w:rPr><w:b/></w:rPr>' : '';
  const pPr = opts?.heading
    ? '<w:pPr><w:spacing w:before="360" w:after="160"/></w:pPr>'
    : '<w:pPr><w:spacing w:after="120"/></w:pPr>';
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${encodeEntities(text)}</w:t></w:r></w:p>`;
}

function appendSectionXml(xml: string, heading: string, paragraphs: string[]): [string, number] {
  const block =
    paragraphXml(heading, { heading: true, bold: true }) +
    paragraphs.map((t) => paragraphXml(t)).join('');
  const added = 1 + paragraphs.length;
  // Insert before the body-level sectPr (page setup) when present, else before </w:body>.
  const sectIdx = xml.lastIndexOf('<w:sectPr');
  const bodyClose = xml.lastIndexOf('</w:body>');
  const at = sectIdx > -1 && sectIdx < bodyClose ? sectIdx : bodyClose;
  if (at < 0) throw new Error('DOCX ohne <w:body> — Datei ist kein gültiges Word-Dokument.');
  return [xml.slice(0, at) + block + xml.slice(at), added];
}

/** Apply improvement ops to an uploaded DOCX. Throws on a structurally unusable file. */
export function improveDocx(buffer: Buffer, ops: DocxImproveOp[]): DocxImproveResult {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    throw new Error(`DOCX ist kein lesbares OPC-Archiv: ${(err as Error).message}`);
  }
  const docPath = 'word/document.xml';
  if (!parts[docPath]) {
    throw new Error('word/document.xml fehlt — ist das wirklich eine .docx-Datei?');
  }

  let xml = strFromU8(parts[docPath]);
  let replacements = 0;
  let appendedParagraphs = 0;
  const skipped: DocxReplaceOp[] = [];

  for (const op of ops) {
    if (op.type === 'replaceText') {
      const [next, count] = replaceInDocumentXml(xml, op.find, op.replace);
      if (count === 0) {
        skipped.push(op);
      } else {
        xml = next;
        replacements += count;
      }
    } else {
      const [next, added] = appendSectionXml(xml, op.heading, op.paragraphs);
      xml = next;
      appendedParagraphs += added;
    }
  }

  parts[docPath] = strToU8(xml);
  return {
    buffer: Buffer.from(zipSync(parts)),
    replacements,
    appendedParagraphs,
    skipped,
  };
}
