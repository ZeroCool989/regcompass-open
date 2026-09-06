import { describe, expect, it } from 'vitest';
import { ChronologicalConversationRetriever } from '../memory-retrieval';
import { MemoryConfig } from '../memory-config';
import type { SeedSourceMessage } from '../memory-seed';

const pair = (seq: number, content: string): SeedSourceMessage[] => [
  { seq: seq, role: 'user', content: `Frage ${content}`, status: 'complete' },
  { seq: seq + 1, role: 'assistant', content: `Antwort ${content}`, status: 'complete' },
];

describe('ChronologicalConversationRetriever', () => {
  const retriever = new ChronologicalConversationRetriever();

  it('returns API-ready alternating pairs, oldest->newest', () => {
    const rows = [...pair(1, 'A'), ...pair(3, 'B')];
    const out = retriever.retrieve({ messages: rows, language: 'de' });
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[0].content).toContain('A');
    expect(out[2].content).toContain('B');
  });

  it('honors the budget (drops oldest) but always keeps the minimum pairs', () => {
    const big = 'x'.repeat(8000);
    const rows = [...pair(1, big), ...pair(3, big), ...pair(5, big)];
    const out = retriever.retrieve({ messages: rows, language: 'de', budgetTokens: 100 });
    expect(out.length).toBeGreaterThanOrEqual(MemoryConfig.minimumConversationPairs * 2);
    expect(out[out.length - 1].role).toBe('assistant');
  });
});
