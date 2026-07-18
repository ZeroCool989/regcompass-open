import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

/**
 * Surgical improvement of an UPLOADED .pptx (target architecture §4): never
 * round-trip a client deck through a JS object model — unzip with fflate, edit
 * only the target slide XML parts, and rezip everything else from the original
 * bytes. Theme, masters, layouts, charts, images, and metadata survive *by
 * construction* because their parts are never touched.
 *
 * Two operations, both content-preserving by design:
 *  - replaceText: exact-match replacement inside <a:t> runs only (run
 *    properties — font, size, color — belong to the run, not the text, so the
 *    client's formatting is untouched).
 *  - appendSlide: clone an existing slide of THEIR deck as the layout basis
 *    (their master/layout relationship is copied with it), swap its text
 *    frames for our title + bullet lines, and register the new slide in
 *    [Content_Types].xml, presentation.xml and its .rels.
 */

export type ReplaceTextOp = {
  type: 'replaceText';
  /** Exact text to find inside text runs (after XML entity decoding). */
  find: string;
  replace: string;
  /** 1-based slide number; omitted = all slides. */
  slide?: number;
};

export type AppendSlideOp = {
  type: 'appendSlide';
  title: string;
  lines: string[];
};

export type ImproveOp = ReplaceTextOp | AppendSlideOp;

export type ImproveResult = {
  buffer: Buffer;
  replacements: number;
  appendedSlides: number;
  slideCount: number;
};

export type PptxStructure = {
  slideCount: number;
  slides: { index: number; textPreview: string }[];
};

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const RUN_TEXT_RE = /(<a:t[^>]*>)([\s\S]*?)(<\/a:t>)/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
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

function slideNames(parts: Record<string, Uint8Array>): string[] {
  return Object.keys(parts)
    .filter((n) => SLIDE_RE.test(n))
    .sort((a, b) => Number(a.match(SLIDE_RE)![1]) - Number(b.match(SLIDE_RE)![1]));
}

/** Cheap structural summary of an uploaded deck (for the tool/UI). */
export function parsePptxStructure(buffer: Buffer): PptxStructure {
  const parts = unzipSync(new Uint8Array(buffer));
  const names = slideNames(parts);
  const slides = names.map((name) => {
    const xml = strFromU8(parts[name]);
    const texts = [...xml.matchAll(RUN_TEXT_RE)].map((m) => decodeEntities(m[2]));
    return {
      index: Number(name.match(SLIDE_RE)![1]),
      textPreview: texts.join(' ').trim().slice(0, 120),
    };
  });
  return { slideCount: names.length, slides };
}

/** Ensure a shape's bodyPr carries PowerPoint autofit (used when an edit lengthens its text). */
function ensureAutofit(spXml: string): string {
  if (/<a:normAutofit|<a:spAutoFit/.test(spXml)) return spXml;
  if (/<a:bodyPr[^>]*\/>/.test(spXml)) {
    return spXml.replace(/<a:bodyPr([^>]*)\/>/, '<a:bodyPr$1><a:normAutofit/></a:bodyPr>');
  }
  return spXml.replace(/(<a:bodyPr[^>]*>)/, '$1<a:normAutofit/>');
}

/**
 * Replace `find` with `replace` inside <a:t> runs of one slide XML, shape by
 * shape. When a replacement makes a shape's text substantially longer than
 * before, the shape gets PowerPoint autofit so the client's box shrinks the
 * text instead of overflowing (design-preserving). Returns [xml, count].
 */
function replaceInSlideXml(xml: string, find: string, replace: string): [string, number] {
  let count = 0;
  const out = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (spXml) => {
    let spCount = 0;
    let originalLen = 0;
    let newLen = 0;
    let edited = spXml.replace(RUN_TEXT_RE, (_all, open: string, inner: string, close: string) => {
      const decoded = decodeEntities(inner);
      originalLen += decoded.length;
      if (!decoded.includes(find)) {
        newLen += decoded.length;
        return `${open}${inner}${close}`;
      }
      const parts = decoded.split(find);
      spCount += parts.length - 1;
      const next = parts.join(replace);
      newLen += next.length;
      return `${open}${encodeEntities(next)}${close}`;
    });
    if (spCount > 0 && newLen > originalLen * 1.3) edited = ensureAutofit(edited);
    count += spCount;
    return edited;
  });
  return [out, count];
}

/**
 * Pick the template slide for appendSlide: the LAST slide that has at least
 * two text-bearing shapes (a title-ish and a body-ish frame). Falls back to
 * the last slide. Deterministic and explainable.
 */
function pickTemplate(parts: Record<string, Uint8Array>): string {
  const names = slideNames(parts);
  for (let i = names.length - 1; i >= 0; i--) {
    const xml = strFromU8(parts[names[i]]);
    const textShapes = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).filter((sp) => /<p:txBody>/.test(sp) && /<a:t[^>]*>[^<]/.test(sp));
    if (textShapes.length >= 2) return names[i];
  }
  return names[names.length - 1];
}

/** Replace all runs of a shape's txBody with a single run carrying `text` (keeps first run's rPr). */
function setShapeText(spXml: string, text: string): string {
  const txBody = spXml.match(/<p:txBody>[\s\S]*?<\/p:txBody>/)?.[0];
  if (!txBody) return spXml;
  const firstPara = txBody.match(/<a:p\b[\s\S]*?<\/a:p>/)?.[0];
  if (!firstPara) return spXml;
  const rPr = firstPara.match(/<a:rPr[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] ?? '';
  const pPr = firstPara.match(/<a:pPr[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/)?.[0] ?? '';
  const newPara = `<a:p>${pPr}<a:r>${rPr}<a:t>${encodeEntities(text)}</a:t></a:r></a:p>`;
  // One paragraph replaces all paragraphs of this frame.
  const newBody = txBody.replace(/<a:p\b[\s\S]*<\/a:p>/, newPara);
  return spXml.replace(txBody, newBody);
}

/** Replace a shape's paragraphs with one bullet paragraph per line (prototype = first paragraph). */
function setShapeLines(spXml: string, lines: string[]): string {
  const txBody = spXml.match(/<p:txBody>[\s\S]*?<\/p:txBody>/)?.[0];
  if (!txBody) return spXml;
  const firstPara = txBody.match(/<a:p\b[\s\S]*?<\/a:p>/)?.[0];
  if (!firstPara) return spXml;
  const rPr = firstPara.match(/<a:rPr[^>]*(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] ?? '';
  const pPr = firstPara.match(/<a:pPr[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/)?.[0] ?? '';
  const paras = lines
    .map((line) => `<a:p>${pPr}<a:r>${rPr}<a:t>${encodeEntities(line)}</a:t></a:r></a:p>`)
    .join('');
  const newBody = txBody.replace(/<a:p\b[\s\S]*<\/a:p>/, paras);
  return spXml.replace(txBody, newBody);
}

function buildAppendedSlideXml(templateXml: string, title: string, lines: string[]): string {
  const shapes = templateXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
  const textShapes = shapes.filter((sp) => /<p:txBody>/.test(sp) && /<a:t[^>]*>[^<]/.test(sp));
  let xml = templateXml;
  if (textShapes.length === 0) return xml;

  // First text frame → our title; second → the bullet lines; any further
  // text frames are emptied of content but kept for the design (their fills/
  // outlines are part of the client's look).
  xml = xml.replace(textShapes[0], setShapeText(textShapes[0], title));
  if (textShapes.length > 1) {
    // The body frame inherits the client's box size — autofit guarantees our
    // findings lines shrink to fit rather than overflow their design.
    xml = xml.replace(textShapes[1], ensureAutofit(setShapeLines(textShapes[1], lines)));
    for (const sp of textShapes.slice(2)) xml = xml.replace(sp, setShapeText(sp, ''));
  } else {
    // Single text frame: title + lines share it.
    xml = xml.replace(textShapes[0], ensureAutofit(setShapeLines(textShapes[0], [title, ...lines])));
  }
  return xml;
}

/** Apply improvement ops to an uploaded deck. Throws on a structurally unusable file. */
export function improvePptx(buffer: Buffer, ops: ImproveOp[]): ImproveResult {
  const parts = unzipSync(new Uint8Array(buffer));
  const names = slideNames(parts);
  if (names.length === 0) {
    throw new Error('Die Datei enthält keine Folien — ist das wirklich eine .pptx-Präsentation?');
  }

  let replacements = 0;
  let appendedSlides = 0;

  for (const op of ops) {
    if (op.type === 'replaceText') {
      const targets = op.slide ? names.filter((n) => Number(n.match(SLIDE_RE)![1]) === op.slide) : names;
      for (const name of targets) {
        const [xml, count] = replaceInSlideXml(strFromU8(parts[name]), op.find, op.replace);
        if (count > 0) {
          parts[name] = strToU8(xml);
          replacements += count;
        }
      }
    } else {
      // appendSlide — clone their slide as layout basis, then register it.
      const templateName = pickTemplate(parts);
      const templateNo = Number(templateName.match(SLIDE_RE)![1]);
      const newNo = Math.max(...slideNames(parts).map((n) => Number(n.match(SLIDE_RE)![1]))) + 1;
      const newName = `ppt/slides/slide${newNo}.xml`;

      parts[newName] = strToU8(buildAppendedSlideXml(strFromU8(parts[templateName]), op.title, op.lines));

      // Slide relationships: copy the template's (keeps the slideLayout →
      // master → theme chain), minus notesSlide references.
      const relName = `ppt/slides/_rels/slide${templateNo}.xml.rels`;
      const newRelName = `ppt/slides/_rels/slide${newNo}.xml.rels`;
      if (parts[relName]) {
        const rel = strFromU8(parts[relName]).replace(/<Relationship [^>]*notesSlide[^>]*\/>/g, '');
        parts[newRelName] = strToU8(rel);
      }

      // [Content_Types].xml override.
      const ctName = '[Content_Types].xml';
      const ct = strFromU8(parts[ctName]);
      parts[ctName] = strToU8(
        ct.replace(
          '</Types>',
          `<Override PartName="/${newName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
        ),
      );

      // presentation.xml.rels: new rId → the slide part.
      const presRelName = 'ppt/_rels/presentation.xml.rels';
      const presRel = strFromU8(parts[presRelName]);
      const maxRid = Math.max(0, ...[...presRel.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
      const newRid = `rId${maxRid + 1}`;
      parts[presRelName] = strToU8(
        presRel.replace(
          '</Relationships>',
          `<Relationship Id="${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNo}.xml"/></Relationships>`,
        ),
      );

      // presentation.xml: append to sldIdLst (sldId ids must be >= 256 and unique).
      const presName = 'ppt/presentation.xml';
      const pres = strFromU8(parts[presName]);
      const maxSldId = Math.max(255, ...[...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1])));
      parts[presName] = strToU8(
        pres.replace('</p:sldIdLst>', `<p:sldId id="${maxSldId + 1}" r:id="${newRid}"/></p:sldIdLst>`),
      );

      appendedSlides += 1;
    }
  }

  const zipped = zipSync(parts);
  return {
    buffer: Buffer.from(zipped),
    replacements,
    appendedSlides,
    slideCount: slideNames(parts).length,
  };
}
