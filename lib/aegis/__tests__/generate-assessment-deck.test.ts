import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GapFinding } from '../gap-finding';

const getSavedFindings = vi.fn();
const storeDocument = vi.fn();

vi.mock('../findings-store', () => ({ getSavedFindings: (...a: unknown[]) => getSavedFindings(...a) }));
vi.mock('../document-store', () => ({ storeDocument: (...a: unknown[]) => storeDocument(...a) }));

import { executeGenerateAssessmentDeck } from '../tools/generate_assessment_deck';

const finding = (over: Partial<GapFinding> = {}): GapFinding => ({
  id: 'GAP-001', regulation: 'EU AI Act', article: 'Art. 5', requirementId: 'R-AIACT-005',
  requirementTitle: 'Prohibited AI Practices', requirementArea: 'Governance', policySection: '',
  policyExcerpt: 'x', status: 'missing', gapDescription: 'Lücke.', riskImpact: 'Risiko.',
  severity: 'Critical', recommendation: 'Beheben.', evidence: 'e', citations: ['R-AIACT-005'],
  confidence: 0.9, reason: 'r', ...over,
});

beforeEach(() => {
  getSavedFindings.mockReset();
  storeDocument.mockReset();
  storeDocument.mockResolvedValue('deck-123');
});

describe('executeGenerateAssessmentDeck', () => {
  it('reuses saved gap findings and stores a downloadable .pptx', async () => {
    getSavedFindings.mockResolvedValue([finding()]);
    const res = await executeGenerateAssessmentDeck({ policyDocumentId: 'p1', title: 'Mein Deck' }, { sessionId: 's1' });

    expect(getSavedFindings).toHaveBeenCalledWith('s1', 'p1');
    expect(res.downloadId).toBe('deck-123');
    expect(res.filename).toMatch(/\.pptx$/);
    expect(res.summary.findings).toBe(1);
    // stored as a binary 'deck' with a real buffer
    const [doc] = storeDocument.mock.calls[0];
    expect(doc.type).toBe('deck');
    expect(Buffer.isBuffer(doc.excelBuffer)).toBe(true);
  });

  it('works on the assess path with validated requirement ids (no document)', async () => {
    const res = await executeGenerateAssessmentDeck({ requirementIds: ['R-AIACT-005', 'R-FAKE-000'] }, { sessionId: 's1' });
    expect(res.summary.obligations).toBeGreaterThanOrEqual(1);
    expect(getSavedFindings).not.toHaveBeenCalled();
  });

  it('throws when there is no session', async () => {
    await expect(executeGenerateAssessmentDeck({ policyDocumentId: 'p1' }, { sessionId: null })).rejects.toThrow();
  });

  it('throws when there are no findings and no resolvable ids (never fabricates)', async () => {
    getSavedFindings.mockResolvedValue([]);
    await expect(
      executeGenerateAssessmentDeck({ policyDocumentId: 'p1', requirementIds: ['R-FAKE-000'] }, { sessionId: 's1' }),
    ).rejects.toThrow(/Keine strukturierten/);
    expect(storeDocument).not.toHaveBeenCalled();
  });
});
