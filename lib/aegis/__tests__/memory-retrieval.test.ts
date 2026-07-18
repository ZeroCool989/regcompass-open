import { describe, expect, it } from 'vitest';
import {
  ChronologicalConversationRetriever,
  FullDocumentRetriever,
  PriorityContextBuilder,
} from '../memory-retrieval';
import { MemoryConfig } from '../memory-config';
import type { SeedSourceMessage, SeedMessage } from '../memory-seed';

const pair = (seq: number, content: string): SeedSourceMessage[] => [
  { seq: seq, role: 'user', content: `Frage ${content}`, status: 'complete' },
  { seq: seq + 1, role: 'assistant', content: `Antwort ${content}`, status: 'complete' },
];

describe('ChronologicalConversationRetriever', () => {
  const retriever = new ChronologicalConversationRetriever();

  it('returns API-ready alternating pairs, oldest→newest', () => {
    const rows = [...pair(1, 'A'), ...pair(3, 'B')];
    const out = retriever.retrieve({ messages: rows, language: 'de' });
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[0].content).toContain('A');
    expect(out[2].content).toContain('B');
  });

  it('honors the budget (drops oldest) but always keeps the minimum pairs', () => {
    // Three large pairs; a tiny budget must still yield at least the minimum.
    const big = 'x'.repeat(8000);
    const rows = [...pair(1, big), ...pair(3, big), ...pair(5, big)];
    const out = retriever.retrieve({ messages: rows, language: 'de', budgetTokens: 100 });
    expect(out.length).toBeGreaterThanOrEqual(MemoryConfig.minimumConversationPairs * 2);
    // The kept pair is the NEWEST (last) one.
    expect(out[out.length - 1].role).toBe('assistant');
  });
});

describe('FullDocumentRetriever', () => {
  it('returns the whole document as a single chunk (seam for future chunking)', () => {
    const out = new FullDocumentRetriever().retrieve({ documentId: 'doc-1', text: 'A'.repeat(500) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ documentId: 'doc-1', index: 0 });
    expect(out[0].text.length).toBe(500);
  });
});

describe('PriorityContextBuilder', () => {
  const builder = new PriorityContextBuilder();
  const conversation: SeedMessage[] = [
    { role: 'user', content: 'alte Frage' },
    { role: 'assistant', content: 'alte Antwort' },
  ];

  it('orders: system → soul (last system block); conversation → docs → current user (last message)', () => {
    const ctx = builder.build({
      systemBlocks: [{ text: 'IDENTITY', cached: true }, { text: 'MODE', cached: true }],
      soulBlock: { text: 'SOUL', cached: false },
      userRequest: 'neue Frage',
      conversation,
      documentChunks: [{ documentId: 'd', index: 0, text: 'DOC TEXT' }],
    });

    // Soul is the LAST system block (uncached trailing).
    expect(ctx.systemBlocks.map((b) => b.text)).toEqual(['IDENTITY', 'MODE', 'SOUL']);
    expect(ctx.systemBlocks[ctx.systemBlocks.length - 1].cached).toBe(false);

    // Conversation first, then retrieved doc context, then the current user request LAST.
    expect(ctx.messages[0].content).toBe('alte Frage');
    expect(ctx.messages.some((m) => m.content.includes('RETRIEVED DOCUMENT CONTEXT'))).toBe(true);
    expect(ctx.messages[ctx.messages.length - 1]).toEqual({ role: 'user', content: 'neue Frage' });
  });

  it('omits soul + doc blocks when not provided', () => {
    const ctx = builder.build({
      systemBlocks: [{ text: 'IDENTITY', cached: true }],
      userRequest: 'frage',
      conversation,
    });
    expect(ctx.systemBlocks).toHaveLength(1);
    expect(ctx.messages.some((m) => m.content.includes('RETRIEVED DOCUMENT CONTEXT'))).toBe(false);
    expect(ctx.messages[ctx.messages.length - 1].content).toBe('frage');
  });
});
