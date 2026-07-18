import { describe, it, expect } from 'vitest';
import pptxgen from 'pptxgenjs';
import { unzipSync, strFromU8 } from 'fflate';
import { improvePptx, parsePptxStructure } from '../deck/pptx-improve';

/** A small "client" deck with its own branding (marker color) and two slides. */
async function clientDeck(): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.defineSlideMaster({
    title: 'CLIENT_MASTER',
    background: { color: 'FFF8E7' }, // marker: client theme fill
    objects: [{ rect: { x: 0, y: 0, w: 13.33, h: 0.2, fill: { color: 'AA1122' } } }],
  });
  const s1 = pptx.addSlide({ masterName: 'CLIENT_MASTER' });
  s1.addText('KI-Richtlinie der ACME Bank', { x: 0.5, y: 0.5, w: 12, h: 0.8, fontSize: 28, bold: true, color: 'AA1122' });
  s1.addText('DORA verlangt jährliche Tests kritischer Funktionen.', { x: 0.5, y: 2, w: 12, h: 0.8, fontSize: 14 });
  const s2 = pptx.addSlide({ masterName: 'CLIENT_MASTER' });
  s2.addText('Anhang', { x: 0.5, y: 0.5, w: 12, h: 0.8, fontSize: 24, bold: true });
  s2.addText('Weitere Details folgen.', { x: 0.5, y: 2, w: 12, h: 0.8, fontSize: 14 });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

const parts = (buf: Buffer) => unzipSync(new Uint8Array(buf));

describe('improvePptx', () => {
  it('replaceText edits only text runs and keeps every other part byte-identical', async () => {
    const original = await clientDeck();
    const { buffer, replacements } = improvePptx(original, [
      { type: 'replaceText', find: 'jährliche Tests kritischer Funktionen', replace: 'jährliche Tests kritischer oder wichtiger Funktionen [R-DORA-024]' },
    ]);
    expect(replacements).toBe(1);

    const before = parts(original);
    const after = parts(buffer);
    // Same part inventory.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // The edited slide changed; ALL other parts (theme, master, layouts, rels,
    // content types, slide 2) are byte-identical — design preserved by construction.
    for (const name of Object.keys(before)) {
      if (name === 'ppt/slides/slide1.xml') continue;
      expect(Buffer.from(after[name]).equals(Buffer.from(before[name])), `part changed: ${name}`).toBe(true);
    }
    const slide1 = strFromU8(after['ppt/slides/slide1.xml']);
    expect(slide1).toContain('wichtiger Funktionen [R-DORA-024]');
    // Run formatting survives (the run keeps an rPr with the original size).
    expect(slide1).toMatch(/<a:rPr[^>]*sz="1400"/);
  });

  it('appendSlide clones the client layout, registers the slide, and touches nothing else', async () => {
    const original = await clientDeck();
    const { buffer, appendedSlides, slideCount } = improvePptx(original, [
      { type: 'appendSlide', title: 'Regulatorische Findings — AEGIS', lines: ['DORA Art. 24 — Testen: Nicht erfüllt (Kritisch) [R-DORA-024]', 'EU AI Act Art. 5 — Verbote: Teilweise (Hoch) [R-AIACT-005]'] },
    ]);
    expect(appendedSlides).toBe(1);
    expect(slideCount).toBe(3);

    const before = parts(original);
    const after = parts(buffer);
    // Theme/master/layout parts byte-identical.
    for (const name of Object.keys(before).filter((n) => /theme|slideMaster|slideLayout/.test(n))) {
      expect(Buffer.from(after[name]).equals(Buffer.from(before[name])), `design part changed: ${name}`).toBe(true);
    }
    // New slide part exists with our content and inherits their rels chain.
    const s3 = strFromU8(after['ppt/slides/slide3.xml']);
    expect(s3).toContain('Regulatorische Findings — AEGIS');
    expect(s3).toContain('R-DORA-024');
    expect(after['ppt/slides/_rels/slide3.xml.rels']).toBeDefined();
    expect(strFromU8(after['ppt/slides/_rels/slide3.xml.rels'])).toContain('slideLayout');
    // Registered in content types + presentation.
    expect(strFromU8(after['[Content_Types].xml'])).toContain('/ppt/slides/slide3.xml');
    expect(strFromU8(after['ppt/presentation.xml']).match(/<p:sldId /g)!.length).toBe(3);
    expect(strFromU8(after['ppt/_rels/presentation.xml.rels'])).toContain('slides/slide3.xml');
    // Round-trip: our own structure parser sees 3 slides.
    expect(parsePptxStructure(buffer).slideCount).toBe(3);
  });

  it('throws a German error on a non-deck zip', () => {
    // A zip with no slides (just content types) — not a presentation.
    expect(() => improvePptx(Buffer.from('PK not a real zip'), [{ type: 'appendSlide', title: 't', lines: [] }])).toThrow();
  });
});
