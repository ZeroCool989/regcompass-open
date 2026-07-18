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
      { role: 'aegis', content: 'Eine klare Governance mit Verantwortlichkeiten und Kontrollen.', toolCallCount: 1, inputTokens: 3000 },
    ];
    const h = computeContextHealth(turns);
    expect(h.band).toBe('excellent');
    expect(h.score).toBeGreaterThanOrEqual(80);
    expect(h.recommendCompaction).toBe('none');
  });

  it('penalizes heavy redundancy (repeated turns)', () => {
    const repeated =
      'Bitte erkläre die Governance Anforderungen für künstliche Intelligenz im Detail';
    const turns: HealthTurn[] = [];
    for (let i = 0; i < 6; i++) {
      turns.push({ role: 'user', content: repeated });
      turns.push({ role: 'aegis', content: repeated, toolCallCount: 0, inputTokens: 4000 });
    }
    const clean = computeContextHealth([
      { role: 'user', content: 'Erste eindeutige Frage zur Aufsicht.' },
      { role: 'aegis', content: 'Eine völlig andere, eigenständige Antwort dazu.', inputTokens: 4000 },
    ]);
    const redundant = computeContextHealth(turns);
    expect(redundant.factors.redundancy).toBeGreaterThan(clean.factors.redundancy);
    expect(redundant.score).toBeLessThan(clean.score);
  });

  it('penalizes heavy tool-output load', () => {
    const light = computeContextHealth([
      { role: 'user', content: 'Frage eins.' },
      { role: 'aegis', content: 'Antwort eins.', toolCallCount: 0, inputTokens: 3000 },
    ]);
    const heavy = computeContextHealth([
      { role: 'user', content: 'Frage eins.' },
      { role: 'aegis', content: 'Antwort eins.', toolCallCount: 12, inputTokens: 3000 },
    ]);
    expect(heavy.factors.toolLoad).toBeGreaterThan(light.factors.toolLoad);
  });

  it('gates utilization below the 120K landmark', () => {
    const small = computeContextHealth([
      { role: 'aegis', content: 'x', inputTokens: 50_000 },
    ]);
    expect(small.factors.utilization).toBe(0);
  });

  it('counts cache-read tokens toward context size (not just uncached input)', () => {
    // Caching makes inputTokens tiny while the real context lives in cachedTokens.
    const cached = computeContextHealth([
      { role: 'aegis', content: 'x', inputTokens: 5_000, cachedTokens: 140_000 },
    ]);
    expect(cached.approxTokens).toBe(145_000);
    expect(cached.factors.utilization).toBeGreaterThan(0);
    expect(cached.recommendCompaction).toBe('hard');
  });

  it('recommends hard compaction near the compaction trigger', () => {
    const huge = computeContextHealth([
      { role: 'user', content: 'frage' },
      { role: 'aegis', content: 'antwort', inputTokens: 145_000 },
    ]);
    expect(huge.factors.utilization).toBeGreaterThan(0);
    expect(huge.recommendCompaction).toBe('hard');
  });

  it('flags trailing unanswered user turns as open loops', () => {
    const h = computeContextHealth([
      { role: 'user', content: 'Erste Frage.' },
      { role: 'aegis', content: 'Antwort.', inputTokens: 2000 },
      { role: 'user', content: 'Zweite Frage ohne Antwort?' },
      { role: 'user', content: 'Dritte Frage ohne Antwort?' },
    ]);
    expect(h.factors.openLoops).toBeGreaterThan(0);
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

    it('bands map low → mid → high by percentage', () => {
      expect(fullnessBand(42)).toBe('low');
      expect(fullnessBand(74)).toBe('mid');
      expect(fullnessBand(91)).toBe('high');
    });
  });
});
