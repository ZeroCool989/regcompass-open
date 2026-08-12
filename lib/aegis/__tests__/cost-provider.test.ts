import { afterEach, describe, expect, it } from 'vitest';
import {
  MODEL_IDS,
  PRICING,
  lookupPricing,
  priceStatusFor,
  type ModelPricing,
} from '@/lib/aegis/types';
import { CostAccumulator, computeCost, computeCostRef } from '@/lib/aegis/context/cost';
import { resolveAttributionProvider } from '@/lib/aegis/providers/catalog';

const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe('provider-qualified pricing lookup', () => {
  it('prices Anthropic models from the verified table', () => {
    expect(lookupPricing({ provider: 'anthropic', model: MODEL_IDS.sonnet })).toEqual(
      expect.objectContaining({ input: 3, output: 15 }),
    );
    expect(priceStatusFor({ provider: 'anthropic', model: MODEL_IDS.sonnet })).toBe('priced');
  });

  it('marks Gemini models pricing_unknown while the Gemini table is unconfigured', () => {
    expect(lookupPricing({ provider: 'gemini', model: 'gemini-2.5-pro' })).toBeNull();
    expect(priceStatusFor({ provider: 'gemini', model: 'gemini-2.5-pro' })).toBe('pricing_unknown');
  });

  it('marks ChatGPT/Codex subscription_unpriced (never per-token here)', () => {
    expect(priceStatusFor({ provider: 'chatgpt-codex', model: 'gpt-5.5-codex' })).toBe('subscription_unpriced');
  });

  it('attributes the local escape-hatch brains honestly (never Anthropic-priced)', () => {
    // OpenAI-proper / local / self-hosted: a per-token provider with no rate here.
    expect(priceStatusFor({ provider: 'openai', model: 'gpt-4.1' })).toBe('pricing_unknown');
    expect(priceStatusFor({ provider: 'ollama', model: 'llama3.3' })).toBe('pricing_unknown');
    expect(priceStatusFor({ provider: 'custom', model: 'hermes-1' })).toBe('pricing_unknown');
    // The CLI bridge rides a subscription you're already signed in to.
    expect(priceStatusFor({ provider: 'cli', model: 'claude-sonnet-4-6' })).toBe('subscription_unpriced');
    // And crucially none of them borrow an Anthropic rate.
    for (const provider of ['openai', 'ollama', 'custom', 'cli'] as const) {
      expect(computeCostRef({ provider, model: 'claude-sonnet-4-6' }, USAGE).costCents).toBeNull();
    }
  });
});

describe('computeCostRef — statuses and no substitution', () => {
  it('prices an Anthropic call identically to the legacy computeCost', () => {
    const ref = computeCostRef({ provider: 'anthropic', model: MODEL_IDS.sonnet }, USAGE);
    expect(ref.status).toBe('priced');
    expect(ref.costCents).toBeCloseTo(computeCost(MODEL_IDS.sonnet, USAGE), 10);
  });

  it('returns null cost for ChatGPT/Codex — never a per-token figure', () => {
    expect(computeCostRef({ provider: 'chatgpt-codex', model: 'gpt-5.5-codex' }, USAGE)).toEqual({
      costCents: null,
      status: 'subscription_unpriced',
    });
  });

  it('returns null (pricing_unknown), NOT Anthropic pricing, for an unconfigured Gemini model', () => {
    const gemini = computeCostRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, USAGE);
    expect(gemini).toEqual({ costCents: null, status: 'pricing_unknown' });
    // Point 5: must not equal the Anthropic Sonnet price for the same tokens.
    expect(gemini.costCents).not.toBe(computeCost(MODEL_IDS.sonnet, USAGE));
  });

  it('prices a Gemini model the moment a verified rate is configured', () => {
    const rate: ModelPricing = { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite5m: 0, cacheWrite1h: 0 };
    PRICING.gemini['gemini-test'] = rate;
    try {
      const res = computeCostRef({ provider: 'gemini', model: 'gemini-test' }, USAGE);
      expect(res.status).toBe('priced');
      // 1M input @1.25 + 1M output @10 = 11.25 USD = 1125 cents.
      expect(res.costCents).toBeCloseTo(1125, 6);
    } finally {
      delete PRICING.gemini['gemini-test'];
    }
  });
});

describe('CostAccumulator — provider-aware', () => {
  afterEach(() => {
    delete PRICING.gemini['gemini-test'];
  });

  it('back-compat add() still prices Anthropic and reports priced status', () => {
    const acc = new CostAccumulator();
    acc.add(MODEL_IDS.sonnet, USAGE);
    expect(acc.priceStatus()).toBe('priced');
    expect(acc.totalCentsOrNull()).toBeCloseTo(computeCost(MODEL_IDS.sonnet, USAGE), 10);
    expect(acc.breakdown().status).toBe('priced');
  });

  it('a subscription run tracks tokens but records null cost', () => {
    const acc = new CostAccumulator();
    acc.addRef({ provider: 'chatgpt-codex', model: 'gpt-5.5-codex' }, USAGE);
    expect(acc.priceStatus()).toBe('subscription_unpriced');
    expect(acc.totalCentsOrNull()).toBeNull();
    const bd = acc.breakdown();
    expect(bd.costCents).toBeNull();
    expect(bd.inputTokens).toBe(1_000_000); // tokens still tracked
    expect(bd.outputTokens).toBe(1_000_000);
  });

  it('any unpriced call taints the run total (worst-status-wins)', () => {
    const acc = new CostAccumulator();
    acc.add(MODEL_IDS.haiku, USAGE); // priced
    acc.addRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, USAGE); // pricing_unknown
    expect(acc.priceStatus()).toBe('pricing_unknown');
    expect(acc.totalCentsOrNull()).toBeNull();
  });
});

describe('CostAccumulator — injected provider resolver (runtime wiring)', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('add() prices an Anthropic run unchanged when no override is set', () => {
    delete process.env.AEGIS_BRAIN;
    const acc = new CostAccumulator(resolveAttributionProvider);
    acc.add(MODEL_IDS.sonnet, USAGE);
    expect(acc.priceStatus()).toBe('priced');
    expect(acc.totalCentsOrNull()).toBeCloseTo(computeCost(MODEL_IDS.sonnet, USAGE), 10);
    expect(acc.providerLabel()).toBe('anthropic');
  });

  it('add() attributes a Gemini-brained run to gemini → pricing_unknown, null cost', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    const acc = new CostAccumulator(resolveAttributionProvider);
    // Same nominal haiku id, but the brain override routes it to Gemini.
    acc.add(MODEL_IDS.haiku, USAGE);
    expect(acc.priceStatus()).toBe('pricing_unknown');
    expect(acc.totalCentsOrNull()).toBeNull();
    expect(acc.providerLabel()).toBe('gemini');
  });

  it('add() attributes a CLI-brained run to a subscription (never Anthropic cost)', () => {
    process.env.AEGIS_BRAIN = 'cli';
    process.env.AEGIS_CLI_COMMAND = 'claude';
    const acc = new CostAccumulator(resolveAttributionProvider);
    acc.add(MODEL_IDS.sonnet, USAGE);
    expect(acc.priceStatus()).toBe('subscription_unpriced');
    expect(acc.totalCentsOrNull()).toBeNull();
    expect(acc.providerLabel()).toBe('cli');
  });

  it('the default resolver (no argument) keeps the historical Anthropic behaviour', () => {
    process.env.AEGIS_BRAIN = 'gemini'; // must be ignored: no resolver injected
    const acc = new CostAccumulator();
    acc.add(MODEL_IDS.sonnet, USAGE);
    expect(acc.priceStatus()).toBe('priced');
    expect(acc.providerLabel()).toBe('anthropic');
  });

  it('providerLabel() reports "mixed" when more than one provider contributed', () => {
    const acc = new CostAccumulator();
    acc.addRef({ provider: 'anthropic', model: MODEL_IDS.haiku }, { input_tokens: 10, output_tokens: 10 });
    acc.addRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, { input_tokens: 5_000, output_tokens: 5_000 });
    // Never silently collapsed to one brand; cost is still tainted null by worst-wins.
    expect(acc.providerLabel()).toBe('mixed');
    expect(acc.totalCentsOrNull()).toBeNull();
  });

  it('providerLabel() reports the sole provider for a uniform multi-call run', () => {
    const acc = new CostAccumulator();
    acc.addRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, USAGE);
    acc.addRef({ provider: 'gemini', model: 'gemini-2.5-flash' }, USAGE);
    expect(acc.providerLabel()).toBe('gemini');
  });

  it('providerLabel() defaults to anthropic when nothing was recorded', () => {
    expect(new CostAccumulator().providerLabel()).toBe('anthropic');
  });
});
