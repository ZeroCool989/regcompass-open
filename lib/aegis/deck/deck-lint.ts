import { unzipSync, strFromU8 } from 'fflate';
import { KB } from '@/lib/kb';

/**
 * Structural/layout lint for generated .pptx buffers — the in-process half of
 * the deck verification pair (target architecture §4). Runs on Vercel before
 * every delivery; a headless render check (LibreOffice → PNG → vision) is
 * deliberately out-of-band (F6) and NOT part of this module.
 *
 * What the heuristic CAN catch: text whose estimated metrics clearly exceed
 * its box, shapes placed outside the slide, tables running past the footer
 * zone, citation IDs that don't resolve against the KB, empty text bodies,
 * wrong slide counts.
 *
 * What it CANNOT catch (honest limits): true glyph metrics (we estimate an
 * average character width — ~±15% off for edge cases like ALL-CAPS or long
 * unbreakable tokens), font substitution on the viewer's machine, chart/image
 * rendering, color contrast, and anything requiring an actual raster. Boxes
 * with PowerPoint autofit (<a:normAutofit>) are self-healing, so estimated
 * overflow there is reported as `soft`, never `hard`.
 */

const EMU_PER_IN = 914_400;
const SLIDE_W_IN = 13.33;
/** Content must end above the footer rule at 7.0in. */
const CONTENT_BOTTOM_IN = 7.0;
/** Average glyph width as a fraction of font size (Calibri-ish mixed German text). */
const AVG_CHAR_W = 0.52;
/** Line height multiplier used for estimation. */
const LINE_H = 1.25;
/** Estimated/actual box-height ratio below which overflow is only `soft`. */
const HARD_RATIO = 1.35;

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const CITATION_RE = /\bR-[A-Z0-9]{2,}-[A-Z0-9][A-Z0-9-]*\b/g;

export type DeckLintViolation = {
  slide: number;
  kind: 'overflow' | 'out-of-bounds' | 'table-overrun' | 'unresolved-citation' | 'empty-text' | 'slide-count';
  severity: 'soft' | 'hard';
  detail: string;
};

export type DeckLintResult = {
  ok: boolean;
  hard: number;
  soft: number;
  slides: number;
  violations: DeckLintViolation[];
};

type Box = { xIn: number; yIn: number; wIn: number; hIn: number };

function attr(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`${name}="(-?\\d+)"`));
  return m ? m[1] : null;
}

function parseBox(spXml: string): Box | null {
  const off = spXml.match(/<a:off x="(-?\d+)" y="(-?\d+)"/);
  const ext = spXml.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
  if (!off || !ext) return null;
  return {
    xIn: Number(off[1]) / EMU_PER_IN,
    yIn: Number(off[2]) / EMU_PER_IN,
    wIn: Number(ext[1]) / EMU_PER_IN,
    hIn: Number(ext[2]) / EMU_PER_IN,
  };
}

type Para = { text: string; sizePt: number };

/** Extract paragraphs with their dominant run size from one txBody. */
function parseParas(txBodyXml: string): Para[] {
  const paras: Para[] = [];
  for (const p of txBodyXml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []) {
    const runs = [...p.matchAll(/<a:r>[\s\S]*?<\/a:r>/g)].map((m) => m[0]);
    let text = '';
    let size = 0;
    for (const r of runs) {
      const t = r.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/);
      if (t) text += t[1];
      const sz = attr(r, 'sz');
      if (sz) size = Math.max(size, Number(sz) / 100);
    }
    if (!size) {
      const sz = attr(p, 'sz');
      size = sz ? Number(sz) / 100 : 18; // PowerPoint default body size fallback
    }
    paras.push({ text, sizePt: size });
  }
  return paras;
}

/** Estimated rendered height (inches) of paragraphs constrained to a width. */
function estimateTextHeightIn(paras: Para[], widthIn: number): number {
  let h = 0;
  for (const p of paras) {
    if (!p.text.trim()) {
      h += (p.sizePt * LINE_H) / 72; // empty paragraph still takes a line
      continue;
    }
    const charsPerLine = Math.max(8, Math.floor(widthIn / ((p.sizePt * AVG_CHAR_W) / 72)));
    const lines = Math.max(1, Math.ceil(p.text.length / charsPerLine));
    h += (lines * p.sizePt * LINE_H) / 72;
  }
  return h;
}

/**
 * Lint a generated deck buffer. `expectedSlides` (when provided) asserts the
 * writer produced exactly the planned deck.
 */
export function lintDeckBuffer(buffer: Buffer, expectedSlides?: number): DeckLintResult {
  const parts = unzipSync(new Uint8Array(buffer));
  const violations: DeckLintViolation[] = [];

  const slideNames = Object.keys(parts)
    .filter((n) => SLIDE_RE.test(n))
    .sort((a, b) => Number(a.match(SLIDE_RE)![1]) - Number(b.match(SLIDE_RE)![1]));

  if (expectedSlides !== undefined && slideNames.length !== expectedSlides) {
    violations.push({
      slide: 0,
      kind: 'slide-count',
      severity: 'hard',
      detail: `Erwartet ${expectedSlides} Folien, gefunden ${slideNames.length}.`,
    });
  }

  for (const name of slideNames) {
    const slideNo = Number(name.match(SLIDE_RE)![1]);
    const xml = strFromU8(parts[name]);

    // Shape-level checks (<p:sp> carries text boxes; graphicFrame carries tables).
    for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
      const box = parseBox(sp);
      const txBody = sp.match(/<p:txBody>[\s\S]*?<\/p:txBody>/)?.[0];
      if (!box) continue;

      // Out-of-bounds placement (small tolerance for decorative bleed rects).
      if (box.xIn < -0.05 || box.yIn < -0.05 || box.xIn + box.wIn > SLIDE_W_IN + 0.05 || box.yIn + box.hIn > 7.55) {
        violations.push({
          slide: slideNo,
          kind: 'out-of-bounds',
          severity: 'hard',
          detail: `Form bei ${box.xIn.toFixed(2)}/${box.yIn.toFixed(2)} (${box.wIn.toFixed(2)}×${box.hIn.toFixed(2)} in) ragt über die Folie hinaus.`,
        });
      }

      if (!txBody) continue;
      const paras = parseParas(txBody);
      const joined = paras.map((p) => p.text).join('');
      if (paras.length > 0 && joined.trim() === '') {
        violations.push({ slide: slideNo, kind: 'empty-text', severity: 'soft', detail: 'Leerer Textrahmen.' });
        continue;
      }

      const hasAutofit = /<a:normAutofit/.test(txBody);
      const est = estimateTextHeightIn(paras, Math.max(0.3, box.wIn - 0.1));
      if (est > box.hIn * 1.05) {
        const ratio = est / Math.max(0.01, box.hIn);
        violations.push({
          slide: slideNo,
          kind: 'overflow',
          severity: hasAutofit || ratio <= HARD_RATIO ? 'soft' : 'hard',
          detail: `Text (~${est.toFixed(2)} in geschätzt) überschreitet Rahmenhöhe ${box.hIn.toFixed(2)} in${hasAutofit ? ' (Autofit aktiv)' : ''}.`,
        });
      }
    }

    // Tables: natural height may exceed the declared frame — check against the
    // footer zone instead of the frame extent.
    for (const frame of xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? []) {
      const box = parseBox(frame);
      if (!box || !/<a:tbl>/.test(frame)) continue;
      const rows = frame.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? [];
      let estH = 0;
      for (const row of rows) {
        const cells = row.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) ?? [];
        let rowLines = 1;
        let rowFont = 10;
        for (const c of cells) {
          const paras = parseParas(c);
          const colW = box.wIn / Math.max(1, cells.length);
          const est = estimateTextHeightIn(paras, colW);
          const font = Math.max(...paras.map((p) => p.sizePt), 8);
          rowLines = Math.max(rowLines, Math.ceil(est / ((font * LINE_H) / 72)));
          rowFont = Math.max(rowFont, font);
        }
        estH += (rowLines * rowFont * LINE_H) / 72 + 0.12; // + cell padding
      }
      if (box.yIn + estH > CONTENT_BOTTOM_IN + 0.15) {
        violations.push({
          slide: slideNo,
          kind: 'table-overrun',
          severity: box.yIn + estH > CONTENT_BOTTOM_IN + 0.6 ? 'hard' : 'soft',
          detail: `Tabelle (~${estH.toFixed(2)} in geschätzt ab y=${box.yIn.toFixed(2)}) läuft in die Fußzeile.`,
        });
      }
    }

    // Citation IDs must resolve against the KB (anti-hallucination backstop).
    const texts = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(' ');
    for (const id of new Set(texts.match(CITATION_RE) ?? [])) {
      if (!KB.byId(id)) {
        violations.push({
          slide: slideNo,
          kind: 'unresolved-citation',
          severity: 'hard',
          detail: `Zitierte Anforderungs-ID "${id}" existiert nicht in der Wissensbasis.`,
        });
      }
    }
  }

  const hard = violations.filter((v) => v.severity === 'hard').length;
  const soft = violations.length - hard;
  return { ok: hard === 0, hard, soft, slides: slideNames.length, violations };
}
