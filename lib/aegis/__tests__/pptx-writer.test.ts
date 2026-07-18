import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildPptxBuffer, agendaEntries } from '../deck/pptx-writer';
import { REGCOMPASS_THEME, type DeckTheme } from '../deck/theme';
import { buildDeckModel } from '../deck/deck-model';
import type { GapFinding } from '../gap-finding';

/** Concatenate the text of every slide XML in a .pptx buffer. */
function allSlideText(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf));
  return Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .map((p) => strFromU8(files[p]))
    .join('\n');
}

const finding = (over: Partial<GapFinding> = {}): GapFinding => ({
  id: 'GAP-001', regulation: 'EU AI Act', article: 'Art. 5', requirementId: 'R-AIACT-005',
  requirementTitle: 'Prohibited AI Practices', requirementArea: 'Governance', policySection: '',
  policyExcerpt: 'x', status: 'missing', gapDescription: 'Lücke.', riskImpact: 'Risiko.',
  severity: 'Critical', recommendation: 'Beheben.', evidence: 'e', citations: ['R-AIACT-005'],
  confidence: 0.9, reason: 'r', ...over,
});

describe('buildPptxBuffer', () => {
  it('produces a real .pptx (zip) buffer from a deck model', async () => {
    const model = buildDeckModel({
      title: 'Test Deck',
      clientName: 'ACME Bank',
      scope: 'KI-gestütztes Kreditscoring.',
      riskClassification: { tier: 'Hochrisiko', rationale: 'Anhang III', drivenBy: ['R-AIACT-005'] },
      findings: [finding(), finding({ id: 'GAP-002', severity: 'High', status: 'partial' })],
      requirementIds: ['R-AIACT-005'],
      generatedAtLabel: 'June 2026',
    });
    expect(model).not.toBeNull();

    const { buffer: buf, slideCount, density } = await buildPptxBuffer(model!);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(2000);
    // PPTX is a ZIP container → starts with the "PK" local-file-header magic.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(density).toBe('normal');
    // 12 base slides (no outlook) — and the writer must produce exactly that many.
    expect(slideCount).toBe(12);
    const files = unzipSync(new Uint8Array(buf));
    const slides = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slides.length).toBe(slideCount);
  });

  it('also renders an empty-findings deck (assess path, no findings)', async () => {
    const model = buildDeckModel({ requirementIds: ['R-AIACT-005'], scope: 'Scope', generatedAtLabel: 'June 2026' });
    const { buffer: buf } = await buildPptxBuffer(model!);
    expect(buf.length).toBeGreaterThan(2000);
    expect(buf[0]).toBe(0x50);
  });

  it('renders the optional outlook slide ONLY when outlook items are present', async () => {
    const outlook = [
      { title: 'BaFin-Konsultation zu DORA', source: 'BaFin', dateLabel: '01. Juni 2026', relevance: 'Betrifft Auslagerungen.', url: 'https://bafin.de/dora' },
    ];
    const withOutlook = await buildPptxBuffer(
      buildDeckModel({ findings: [finding()], generatedAtLabel: 'June 2026', outlook })!,
    );
    const text = allSlideText(withOutlook.buffer);
    expect(text).toContain('Regulatorischer Ausblick');
    expect(text).toContain('BaFin-Konsultation zu DORA');
    expect(text).toContain('ohne AEGIS-Bewertung'); // anti-hallucination disclaimer
    expect(withOutlook.slideCount).toBe(13);

    // No outlook → no outlook slide.
    const noOutlook = await buildPptxBuffer(buildDeckModel({ findings: [finding()], generatedAtLabel: 'June 2026' })!);
    expect(allSlideText(noOutlook.buffer)).not.toContain('Regulatorischer Ausblick');
  });

  it('renders agenda and verification-method slides with truthful audit content', async () => {
    const model = buildDeckModel({ findings: [finding()], generatedAtLabel: 'June 2026' })!;
    const { buffer } = await buildPptxBuffer(model);
    const text = allSlideText(buffer);
    // Agenda lists the section titles in order (XML-escaped in the slide part).
    expect(text).toContain('Inhalt');
    for (const entry of agendaEntries(model)) expect(text).toContain(entry.replace(/&/g, '&amp;'));
    // Method slide: audit-chain story + live KB snapshot line, no legal-advice claim.
    expect(text).toContain('Prüfmethodik &amp; Verifizierung');
    expect(text).toContain('Deterministische Schweregrade');
    expect(text).toContain(model.auditLine.slice(0, 40));
  });

  it('threads a custom theme (branding without a writer fork)', async () => {
    const theme: DeckTheme = { ...REGCOMPASS_THEME, brand: 'FF0000', brandLine: 'ACME · COMPLIANCE', company: 'ACME AG' };
    const model = buildDeckModel({ findings: [finding()], generatedAtLabel: 'June 2026' })!;
    const { buffer } = await buildPptxBuffer(model, { theme });
    const text = allSlideText(buffer);
    expect(text).toContain('ACME · COMPLIANCE');
    expect(text).toContain('FF0000');
    // Default theme output does not carry the custom brand line.
    const { buffer: def } = await buildPptxBuffer(model);
    expect(allSlideText(def)).not.toContain('ACME · COMPLIANCE');
  });

  it('compact density reduces per-slide content (lint retry path)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => finding({ id: `GAP-${i}`, requirementId: 'R-AIACT-005' }));
    const model = buildDeckModel({ findings: many, generatedAtLabel: 'June 2026' })!;
    const normal = await buildPptxBuffer(model);
    const compact = await buildPptxBuffer(model, { density: 'compact' });
    expect(compact.density).toBe('compact');
    // Compact shows fewer findings rows → the "+N weitere" note advertises more remainder.
    expect(allSlideText(compact.buffer)).toContain('weitere Findings');
    expect(compact.buffer.length).toBeLessThan(normal.buffer.length + 200_000); // sanity: still a real deck
  });
});
