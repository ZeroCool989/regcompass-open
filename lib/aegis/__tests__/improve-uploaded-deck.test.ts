import { describe, it, expect, vi, beforeEach } from 'vitest';
import pptxgen from 'pptxgenjs';
import type { GapFinding } from '../gap-finding';

const getSavedFindings = vi.fn();
const storeDocument = vi.fn();
const getDocument = vi.fn();

vi.mock('../findings-store', () => ({ getSavedFindings: (...a: unknown[]) => getSavedFindings(...a) }));
vi.mock('../document-store', () => ({
  storeDocument: (...a: unknown[]) => storeDocument(...a),
  getDocument: (...a: unknown[]) => getDocument(...a),
}));

import { executeImproveUploadedDeck } from '../tools/improve_uploaded_deck';

async function uploadedDeck(): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  const s = pptx.addSlide();
  s.addText('Titel', { x: 0.5, y: 0.5, w: 12, h: 0.8, fontSize: 28, bold: true });
  s.addText('BAIT gilt unverändert bis Ende 2026.', { x: 0.5, y: 2, w: 12, h: 0.8, fontSize: 14 });
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

const finding = (over: Partial<GapFinding> = {}): GapFinding => ({
  id: 'GAP-001', regulation: 'EU AI Act', article: 'Art. 5', requirementId: 'R-AIACT-005',
  requirementTitle: 'Prohibited AI Practices', requirementArea: 'Governance', policySection: '',
  policyExcerpt: 'x', status: 'missing', gapDescription: 'Lücke.', riskImpact: 'Risiko.',
  severity: 'Critical', recommendation: 'Beheben.', evidence: 'e', citations: ['R-AIACT-005'],
  confidence: 0.9, reason: 'r', ...over,
});

beforeEach(() => {
  getSavedFindings.mockReset();
  getDocument.mockReset();
  storeDocument.mockReset();
  storeDocument.mockResolvedValue('improved-1');
});

describe('executeImproveUploadedDeck', () => {
  it('applies KB-grounded corrections and appends a findings slide', async () => {
    getDocument.mockResolvedValue({ filename: 'kunde.pptx', excelBuffer: await uploadedDeck() });
    getSavedFindings.mockResolvedValue([finding()]);

    const res = await executeImproveUploadedDeck(
      {
        deckDocumentId: 'up-1',
        corrections: [{ find: 'BAIT gilt unverändert bis Ende 2026.', requirementId: 'R-AIACT-005' }],
        appendFindings: { policyDocumentId: 'pol-1' },
      },
      { sessionId: 's1' },
    );

    expect(res.replacements).toBe(1);
    expect(res.appendedSlides).toBe(1);
    expect(res.slideCount).toBe(2);
    expect(res.filename).toContain('AEGIS-verbessert');
    const [doc] = storeDocument.mock.calls[0];
    expect(doc.type).toBe('deck');
    expect(Buffer.isBuffer(doc.excelBuffer)).toBe(true);
    // Original preserved: we stored a NEW document, never overwrote the upload.
    expect(doc.textContent).toContain('original preserved as up-1');
  });

  it('drops unknown requirement IDs instead of inventing text', async () => {
    getDocument.mockResolvedValue({ filename: 'kunde.pptx', excelBuffer: await uploadedDeck() });
    await expect(
      executeImproveUploadedDeck(
        { deckDocumentId: 'up-1', corrections: [{ find: 'BAIT gilt unverändert bis Ende 2026.', requirementId: 'R-FAKELAW-999' }] },
        { sessionId: 's1' },
      ),
    ).rejects.toThrow(/R-FAKELAW-999/);
    expect(storeDocument).not.toHaveBeenCalled();
  });

  it('refuses files without a preserved original buffer (German guidance)', async () => {
    getDocument.mockResolvedValue({ filename: 'kunde.pptx', excelBuffer: undefined });
    await expect(
      executeImproveUploadedDeck({ deckDocumentId: 'up-1', corrections: [] }, { sessionId: 's1' }),
    ).rejects.toThrow(/erneut hochladen/);
  });

  it('refuses foreign sessions (ownership via getDocument scoping)', async () => {
    getDocument.mockResolvedValue(null);
    await expect(
      executeImproveUploadedDeck({ deckDocumentId: 'up-1' }, { sessionId: 's-other' }),
    ).rejects.toThrow(/nicht gefunden/);
    expect(getDocument).toHaveBeenCalledWith('up-1', 's-other');
  });
});
