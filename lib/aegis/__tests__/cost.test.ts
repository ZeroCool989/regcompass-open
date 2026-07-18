import { describe, expect, it } from 'vitest';
import { computeCost, CostAccumulator, type ClaudeUsage } from '../context/cost';
import { MODEL_IDS } from '../types';

// Helper: build a raw-usage object with sensible zero defaults.
function usage(partial: Partial<ClaudeUsage>): ClaudeUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...partial,
  };
}

// ───────────────────────── computeCost ─────────────────────────

describe('computeCost', () => {
  it('Haiku: 1M fresh input → 100 cents ($1)', () => {
    expect(computeCost(MODEL_IDS.haiku, usage({ input_tokens: 1_000_000 }))).toBeCloseTo(100, 4);
  });

  it('Haiku: 1M output → 500 cents ($5)', () => {
    expect(computeCost(MODEL_IDS.haiku, usage({ output_tokens: 1_000_000 }))).toBeCloseTo(500, 4);
  });

  it('Sonnet: 1M fresh input → 300 cents ($3)', () => {
    expect(computeCost(MODEL_IDS.sonnet, usage({ input_tokens: 1_000_000 }))).toBeCloseTo(300, 4);
  });

  it('Opus: 1M fresh input → 500 cents ($5)', () => {
    expect(computeCost(MODEL_IDS.opus, usage({ input_tokens: 1_000_000 }))).toBeCloseTo(500, 4);
  });

  it('prices cache READ at the discounted rate (Sonnet $0.30/M)', () => {
    expect(
      computeCost(MODEL_IDS.sonnet, usage({ cache_read_input_tokens: 1_000_000 })),
    ).toBeCloseTo(30, 4);
  });

  it('prices cache WRITE above input (Sonnet 5m = $3.75/M, not $3)', () => {
    expect(
      computeCost(MODEL_IDS.sonnet, usage({ cache_creation_input_tokens: 1_000_000 })),
    ).toBeCloseTo(375, 4);
  });

  it('honours the 5m/1h TTL split when the API provides it', () => {
    // Sonnet: 1M @ 5m ($3.75) + 1M @ 1h ($6.00) = $9.75 → 975 cents.
    const cents = computeCost(
      MODEL_IDS.sonnet,
      usage({
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      }),
    );
    expect(cents).toBeCloseTo(975, 3);
  });

  // ── REGRESSION (b): cache tokens must make cost exceed the naive sum ──
  it('counts cache buckets — cost exceeds the naive input+output total', () => {
    const u = usage({
      input_tokens: 100_000,
      output_tokens: 50_000,
      cache_read_input_tokens: 400_000,
      cache_creation_input_tokens: 200_000,
    });

    const full = computeCost(MODEL_IDS.sonnet, u);
    // What the old code charged: only fresh input + output, cache buckets dropped.
    const naive = computeCost(
      MODEL_IDS.sonnet,
      usage({ input_tokens: u.input_tokens, output_tokens: u.output_tokens }),
    );

    expect(full).toBeGreaterThan(naive);
  });

  // ── REGRESSION (a): unknown model must throw, never silently return 0 ──
  it('throws on an unknown model', () => {
    expect(() =>
      // @ts-expect-error — intentionally passing a model with no pricing entry.
      computeCost('claude-made-up-9', usage({ input_tokens: 1_000_000 })),
    ).toThrow(/no pricing for model/i);
  });
});

// ───────────────────────── CostAccumulator ─────────────────────────

describe('CostAccumulator', () => {
  it('accumulates multiple calls and reports totals in cents and USD', () => {
    const acc = new CostAccumulator();
    acc.add(MODEL_IDS.haiku, usage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    acc.add(MODEL_IDS.sonnet, usage({ input_tokens: 1_000_000 }));

    // Haiku: 100 + 500 = 600 cents; Sonnet: 300 cents; total 900 = $9.00
    expect(acc.total()).toBeCloseTo(900, 3);
    expect(acc.totalUsd()).toBeCloseTo(9, 3);
  });

  it('breakdown() exposes every token bucket', () => {
    const acc = new CostAccumulator();
    acc.add(
      MODEL_IDS.sonnet,
      usage({
        input_tokens: 100_000,
        output_tokens: 50_000,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 20_000,
      }),
    );

    const bd = acc.breakdown();
    expect(bd).toMatchObject({
      inputTokens: 100_000,
      outputTokens: 50_000,
      cachedTokens: 30_000,
      cacheCreationTokens: 20_000,
    });
    expect(bd.usd).toBeGreaterThan(0);
  });

  it('entries() returns one record per add() call', () => {
    const acc = new CostAccumulator();
    acc.add(MODEL_IDS.haiku, usage({ input_tokens: 100, output_tokens: 50 }));
    acc.add(MODEL_IDS.opus, usage({ input_tokens: 200, output_tokens: 100 }));

    const entries = acc.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0].model).toBe(MODEL_IDS.haiku);
    expect(entries[1].model).toBe(MODEL_IDS.opus);
  });

  it('starts at zero', () => {
    const acc = new CostAccumulator();
    expect(acc.total()).toBe(0);
    expect(acc.totalUsd()).toBe(0);
    expect(acc.entries()).toHaveLength(0);
  });
});
