import { describe, expect, it, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

// The conversation source must never hit the real API in tests; the document
// path in this file only uses saved findings (no analysis model calls).
vi.mock('../client', () => ({
  callStructured: vi.fn(),
  callHaiku: vi.fn(),
  callClaude: vi.fn(),
}));

import { fakeDb } from './helpers/fake-db';
import { callStructured } from '../client';
import { executeFillTemplate } from '../tools/fill_template';
import { storeDocument, getDocument } from '../document-store';
import { saveFindings } from '../findings-store';
import { createConversation, appendMessage } from '../memory';
import { FILL_NO_FINDINGS_DE, FILL_NO_SOURCE_DE, FILL_CONVERSATION_NOT_FOUND_DE } from '../statusLabels';
import type { GapFinding } from '../gap-finding';

const SESSION = 'test-session';
const mockCall = vi.mocked(callStructured);

async function makeTestExcel(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Assessment');
  ws.addRow(['Regulation', 'Artikel', 'Anforderung', 'Status', 'Priorität']);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

async function storeTemplate(): Promise<string> {
  return storeDocument(
    { filename: 'template.xlsx', type: 'template', textContent: '', excelBuffer: await makeTestExcel() },
    SESSION,
  );
}

const sampleFinding: GapFinding = {
  id: 'GAP-001',
  regulation: 'DORA',
  article: 'Art. 5',
  requirementId: 'R-DORA-001',
  requirementTitle: 'ICT risk management framework',
  requirementArea: 'Governance',
  policySection: 'Kap. 2',
  policyExcerpt: 'Kein Prozess dokumentiert.',
  status: 'missing',
  gapDescription: 'IKT-Risikomanagement fehlt vollständig.',
  riskImpact: 'Hohe operationelle Verwundbarkeit.',
  severity: 'High',
  recommendation: 'Rahmenwerk nach Art. 5 einführen.',
  evidence: 'Policy-Review',
  citations: ['R-DORA-001'],
  confidence: 0.9,
  reason: 'test fixture',
};

const extractedGapItem = {
  findingType: 'gap',
  title: 'Fehlendes IKT-Risikomanagement',
  description: 'Die Unterhaltung stellt fest, dass kein IKT-Risikomanagement dokumentiert ist.',
  regulation: '',
  article: '',
  citations: ['R-DORA-001'],
  severity: 'High',
  confidence: 0.9,
  sourceContext: '',
  requirement: 'IKT-Risikomanagement nach DORA',
  currentState: 'Kein Prozess dokumentiert.',
  status: 'missing',
  rationale: '',
};

afterEach(() => {
  fakeDb.reset();
  mockCall.mockReset();
});

// ───────────────────────── (a) Regression: document path ─────────────────────────

describe('document source — regression', () => {
  it('behaves exactly as before and records kind:document provenance', async () => {
    const policyId = await storeDocument(
      { filename: 'policy.txt', type: 'policy', textContent: 'irrelevant placeholder text' },
      SESSION,
    );
    await saveFindings(SESSION, policyId, [sampleFinding]);
    const templateId = await storeTemplate();

    const result = await executeFillTemplate(
      { policyDocumentId: policyId, templateDocumentId: templateId, targetSheet: 'Assessment' },
      { sessionId: SESSION },
    );

    // Same behavior as pre-change: the one saved finding drives the fill.
    expect(result.summary.total).toBe(1);
    expect(result.summary.added).toBe(1);
    expect(result.downloadId).toBeDefined();
    // No model call on the document path (saved findings reused).
    expect(mockCall).not.toHaveBeenCalled();
    // Additive provenance.
    expect(result.sourceRef).toEqual({ kind: 'document', documentId: policyId });
  });
});

// ───────────────────────── conversation source ─────────────────────────

async function seedConversation(sessionId: string): Promise<{ conversationId: string }> {
  const conversationId = await createConversation({
    sessionId,
    userId: null,
    mode: 'GAP_ANALYZE',
    language: 'de',
    firstUserMessage: 'Bitte Gap-Analyse durchführen.',
  });
  if (!conversationId) throw new Error('fixture: conversation not created');
  await appendMessage(conversationId, {
    role: 'assistant',
    content:
      'Gap-Analyse: Es ist kein IKT-Risikomanagement dokumentiert — Anforderung nach DORA [R-DORA-001] nicht erfüllt.',
    mode: 'GAP_ANALYZE',
    status: 'complete',
    exitReason: 'done',
    citedIds: ['R-DORA-001'],
  });
  return { conversationId };
}

describe('conversation source', () => {
  it('(b) fills from chat findings and persists full provenance', async () => {
    const { conversationId } = await seedConversation(SESSION);
    const templateId = await storeTemplate();
    mockCall.mockResolvedValue({
      value: { items: [extractedGapItem] },
      usage: { input_tokens: 1, output_tokens: 1 },
    } as Awaited<ReturnType<typeof callStructured>>);

    const result = await executeFillTemplate(
      { templateDocumentId: templateId, targetSheet: 'Assessment' },
      { sessionId: SESSION, conversationId },
    );

    expect(result.summary.total).toBe(1);
    expect(result.sourceRef.kind).toBe('conversation');
    if (result.sourceRef.kind === 'conversation') {
      expect(result.sourceRef.conversationId).toBe(conversationId);
      expect(result.sourceRef.messageIds).toHaveLength(1);
      expect(Object.values(result.sourceRef.modeByMessage)).toEqual(['GAP_ANALYZE']);
    }
    // Provenance travels with the stored result record.
    const stored = await getDocument(result.downloadId, SESSION);
    expect(stored?.textContent).toContain('"kind":"conversation"');
    expect(stored?.textContent).toContain(conversationId);
  });

  it('(c) foreign conversation → not-found BEFORE any extraction (limiter/model untouched)', async () => {
    const { conversationId } = await seedConversation('other-session');
    const templateId = await storeTemplate();

    await expect(
      executeFillTemplate(
        { templateDocumentId: templateId },
        { sessionId: SESSION, conversationId },
      ),
    ).rejects.toThrow(FILL_CONVERSATION_NOT_FOUND_DE);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('no conversation in context → central German error', async () => {
    const templateId = await storeTemplate();
    await expect(
      executeFillTemplate({ templateDocumentId: templateId }, { sessionId: SESSION }),
    ).rejects.toThrow(FILL_NO_SOURCE_DE);
  });

  it('conversation without extractable findings → central German error, no invented rows', async () => {
    const { conversationId } = await seedConversation(SESSION);
    const templateId = await storeTemplate();
    mockCall.mockResolvedValue({
      value: { items: [] },
      usage: { input_tokens: 1, output_tokens: 1 },
    } as Awaited<ReturnType<typeof callStructured>>);

    await expect(
      executeFillTemplate({ templateDocumentId: templateId }, { sessionId: SESSION, conversationId }),
    ).rejects.toThrow(FILL_NO_FINDINGS_DE);
  });
});
