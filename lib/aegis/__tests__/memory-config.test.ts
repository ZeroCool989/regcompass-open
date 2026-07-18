import { describe, expect, it } from 'vitest';
import { MemoryConfig, estimateTokensFromChars } from '../memory-config';

describe('MemoryConfig', () => {
  it('exposes production-grade default limits', () => {
    expect(MemoryConfig.seedBudgetTokens).toBe(100_000);
    expect(MemoryConfig.autoCompactionTokens).toBe(150_000);
    expect(MemoryConfig.digestMaxInputTokens).toBe(500_000);
    expect(MemoryConfig.conversationRetentionDays).toBe(30);
    expect(MemoryConfig.minimumConversationPairs).toBe(1);
    expect(MemoryConfig.compactionKeepFirst).toBe(2);
    expect(MemoryConfig.compactionKeepLast).toBe(4);
  });

  it('keeps the limits internally consistent (seed < auto-compaction < digest)', () => {
    expect(MemoryConfig.seedBudgetTokens).toBeLessThan(MemoryConfig.autoCompactionTokens);
    expect(MemoryConfig.autoCompactionTokens).toBeLessThanOrEqual(MemoryConfig.digestMaxInputTokens);
  });

  it('uses denser char→token estimate for German than English', () => {
    expect(MemoryConfig.charsPerTokenDe).toBeLessThan(MemoryConfig.charsPerTokenEn);
    const chars = 1000;
    expect(estimateTokensFromChars(chars, 'de')).toBeGreaterThan(estimateTokensFromChars(chars, 'en'));
    expect(estimateTokensFromChars(1000, 'en')).toBe(250); // 1000 / 4
  });
});
