import { describe, it, expect } from 'vitest';
import pptxgen from 'pptxgenjs';
import { lintDeckBuffer } from '../deck/deck-lint';
import { buildPptxBuffer } from '../deck/pptx-writer';
import { buildDeckModel } from '../deck/deck-model';
import type { GapFinding } from '../gap-finding';

const finding = (over: Partial<GapFinding> = {}): GapFinding => ({
  id: 'GAP-001', regulation: 'EU AI Act', article: 'Art. 5', requirementId: 'R-AIACT-005',
  requirementTitle: 'Prohibited AI Practices', requirementArea: 'Governance', policySection: '',
  policyExcerpt: 'x', status: 'missing', gapDescription: 'Lücke.', riskImpact: 'Risiko.',
  severity: 'Critical', recommendation: 'Beheben.', evidence: 'e', citations: ['R-AIACT-005'],
  confidence: 0.9, reason: 'r', ...over,
});

async function fixtureDeck(build: (pptx: pptxgen) => void): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  build(pptx);
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

describe('lintDeckBuffer', () => {
  it('passes a real generated assessment deck', async () => {
    const model = buildDeckModel({
      findings: [finding(), finding({ id: 'GAP-002', severity: 'High' })],
      requirementIds: ['R-AIACT-005'],
      scope: 'KI-gestütztes Kreditscoring in der Antragsstrecke.',
      generatedAtLabel: 'Juli 2026',
    })!;
    const { buffer, slideCount } = await buildPptxBuffer(model);
    const lint = lintDeckBuffer(buffer, slideCount);
    expect(lint.ok).toBe(true);
    expect(lint.hard).toBe(0);
    expect(lint.slides).toBe(slideCount);
  });

  it('flags massive text overflow in a small box as hard', async () => {
    const buf = await fixtureDeck((p) => {
      const s = p.addSlide();
      // 400 words of 14pt text in a 1×0.4in box, no autofit → unambiguous overflow.
      s.addText(Array.from({ length: 400 }, () => 'Regulierung').join(' '), { x: 1, y: 1, w: 1, h: 0.4, fontSize: 14 });
    });
    const lint = lintDeckBuffer(buf);
    expect(lint.ok).toBe(false);
    expect(lint.violations.some((v) => v.kind === 'overflow' && v.severity === 'hard')).toBe(true);
  });

  it('downgrades overflow to soft when PowerPoint autofit is active', async () => {
    const buf = await fixtureDeck((p) => {
      const s = p.addSlide();
      s.addText(Array.from({ length: 400 }, () => 'Regulierung').join(' '), { x: 1, y: 1, w: 1, h: 0.4, fontSize: 14, fit: 'shrink' });
    });
    const lint = lintDeckBuffer(buf);
    const overflow = lint.violations.filter((v) => v.kind === 'overflow');
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow.every((v) => v.severity === 'soft')).toBe(true);
    expect(lint.ok).toBe(true);
  });

  it('flags shapes placed outside the slide', async () => {
    const buf = await fixtureDeck((p) => {
      const s = p.addSlide();
      s.addText('außerhalb', { x: 13.0, y: 7.2, w: 2, h: 1, fontSize: 12 });
    });
    const lint = lintDeckBuffer(buf);
    expect(lint.violations.some((v) => v.kind === 'out-of-bounds' && v.severity === 'hard')).toBe(true);
  });

  it('flags citation IDs that do not resolve against the KB', async () => {
    const buf = await fixtureDeck((p) => {
      const s = p.addSlide();
      s.addText('Siehe R-FAKELAW-999 für Details.', { x: 1, y: 1, w: 8, h: 1, fontSize: 12 });
    });
    const lint = lintDeckBuffer(buf);
    expect(lint.violations.some((v) => v.kind === 'unresolved-citation' && v.detail.includes('R-FAKELAW-999'))).toBe(true);
    expect(lint.ok).toBe(false);
  });

  it('flags a slide-count mismatch', async () => {
    const buf = await fixtureDeck((p) => {
      p.addSlide().addText('eins', { x: 1, y: 1, w: 4, h: 0.5, fontSize: 12 });
    });
    const lint = lintDeckBuffer(buf, 3);
    expect(lint.violations.some((v) => v.kind === 'slide-count')).toBe(true);
  });
});
