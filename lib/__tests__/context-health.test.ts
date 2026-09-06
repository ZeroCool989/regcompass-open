import { describe, expect, it } from 'vitest';
import {
  computeContextHealth,
  fullnessBand,
  COMPACT_TRIGGER,
  type HealthTurn,
} from '@/lib/aegis/context-health';
import { MemoryConfig } from '@/lib/aegis/memory-config';

describe('context health is driven by the centralized config', () => {
  it('uses MemoryConfig.autoCompactionTokens as the compaction trigger', () => {
    expect(COMPACT_TRIGGER).toBe(MemoryConfig.autoCompactionTokens);
  });

  it('reports 100% fullness exactly at the configured trigger', () => {
    const h = computeContextHealth([
      { role: 'aegis', content: 'x', inputTokens: MemoryConfig.autoCompactionTokens },
    ]);
    expect(h.fullnessPct).toBe(100);
  });
});

describe('computeContextHealth', () => {
  it('scores a short clean conversation as excellent', () => {
    const turns: HealthTurn[] = [
      { role: 'user', content: 'Was fordert die Aufsicht zur KI-Governance?' },
      { role: 'aegis', content: 'Eine klare Governance mit Verantwortlichkeiten und Kontrollen.', inputTokens: 3000 },
    ];
    const h = computeContextHealth(turns);
    expect(h.band).toBe('excellent');
    expect(h.score).toBeGreaterThanOrEqual(80);
    expect(h.recommendCompaction).toBe('none');
  });

  it('counts cache-read tokens toward context size', () => {
    const cached = computeContextHealth([
      { role: 'aegis', content: 'x', inputTokens: 5_000, cachedTokens: 140_000 },
    ]);
    expect(cached.approxTokens).toBe(145_000);
    expect(cached.recommendCompaction).toBe('hard');
  });

  it('recommends hard compaction near the compaction trigger', () => {
    const huge = computeContextHealth([
      { role: 'user', content: 'frage' },
      { role: 'aegis', content: 'antwort', inputTokens: 145_000 },
    ]);
    expect(huge.recommendCompaction).toBe('hard');
  });

  it('recommends soft compaction at moderate fullness', () => {
    const softTokens = Math.round(COMPACT_TRIGGER * 0.85);
    const h = computeContextHealth([
      { role: 'aegis', content: 'x', inputTokens: softTokens },
    ]);
    expect(h.recommendCompaction).toBe('soft');
  });

  it('handles an empty conversation without throwing', () => {
    const h = computeContextHealth([]);
    expect(h.score).toBe(100);
    expect(h.band).toBe('excellent');
  });

  describe('fullness (the "fills up and turns red" gauge)', () => {
    it('is near empty + green for a tiny conversation', () => {
      const h = computeContextHealth([
        { role: 'user', content: 'Kurze Frage?' },
        { role: 'aegis', content: 'Kurze Antwort.', inputTokens: 3_000 },
      ]);
      expect(h.fullnessPct).toBeLessThan(10);
      expect(h.fullnessBand).toBe('low');
    });

    it('reads ~100% and red when at the compaction trigger', () => {
      const h = computeContextHealth([
        { role: 'aegis', content: 'x', inputTokens: 5_000, cachedTokens: 145_000 },
      ]);
      expect(h.fullnessPct).toBe(100);
      expect(h.fullnessBand).toBe('high');
    });

    it('fullness rises monotonically with context size', () => {
      const small = computeContextHealth([{ role: 'aegis', content: 'x', inputTokens: 30_000 }]);
      const big = computeContextHealth([{ role: 'aegis', content: 'x', inputTokens: 120_000 }]);
      expect(big.fullnessPct).toBeGreaterThan(small.fullnessPct);
    });

    it('bands map low -> mid -> high by percentage', () => {
      expect(fullnessBand(42)).toBe('low');
      expect(fullnessBand(74)).toBe('mid');
      expect(fullnessBand(91)).toBe('high');
    });
  });
});
