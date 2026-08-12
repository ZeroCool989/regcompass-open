import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what flush() hands to logUsage without touching the DB.
const { mockLogUsage } = vi.hoisted(() => ({ mockLogUsage: vi.fn() }));
vi.mock('../usage-logger', () => ({ logUsage: mockLogUsage }));

import { UsageRecorder } from '../usage-recorder';
import { MODEL_IDS } from '../types';

describe('UsageRecorder.flush — Phase 2 fields', () => {
  beforeEach(() => mockLogUsage.mockReset());

  it('writes the distinct served-model set and guard tokens onto the row', () => {
    const rec = new UsageRecorder('trace-1', '2026-05-25');
    rec.cost.add(MODEL_IDS.sonnet, {
      input_tokens: 100, output_tokens: 50,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
    rec.setMeta({
      model: MODEL_IDS.sonnet,
      servedModels: ['claude-sonnet-4-6'],
      guardrailsTriggered: ['compress', 'kill:cost_limit'],
      exitReason: 'done',
    });

    rec.flush(1234);

    expect(mockLogUsage).toHaveBeenCalledTimes(1);
    expect(mockLogUsage.mock.calls[0][0]).toMatchObject({
      servedModel: 'claude-sonnet-4-6',
      guardrailsTriggered: ['compress', 'kill:cost_limit'],
    });
  });

  it('joins multiple served models and defaults servedModel to null when none seen', () => {
    const recMulti = new UsageRecorder('t2', 'v');
    recMulti.cost.add(MODEL_IDS.sonnet, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    recMulti.setMeta({ servedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] });
    recMulti.flush(1);
    expect(mockLogUsage.mock.calls[0][0].servedModel).toBe('claude-sonnet-4-6,claude-haiku-4-5-20251001');

    mockLogUsage.mockReset();
    const recNone = new UsageRecorder('t3', 'v');
    recNone.cost.add(MODEL_IDS.haiku, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    recNone.flush(1);
    expect(mockLogUsage.mock.calls[0][0].servedModel).toBeNull();
    expect(mockLogUsage.mock.calls[0][0].guardrailsTriggered).toEqual([]);
  });
});

describe('UsageRecorder.flush — provider attribution', () => {
  const SAVED = { ...process.env };
  beforeEach(() => mockLogUsage.mockReset());
  afterEach(() => {
    process.env = { ...SAVED };
  });

  const ONE_CALL = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it('records provider=anthropic, priced, with a real cost for the default brain', () => {
    delete process.env.AEGIS_BRAIN;
    const rec = new UsageRecorder('t-a', 'v');
    rec.cost.add(MODEL_IDS.sonnet, ONE_CALL);
    rec.flush(1);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.provider).toBe('anthropic');
    expect(row.priceStatus).toBe('priced');
    expect(row.costCents).toBeGreaterThan(0);
  });

  it('attributes a Gemini-brained run to gemini with a null (unpriced) cost', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    const rec = new UsageRecorder('t-g', 'v');
    rec.cost.add(MODEL_IDS.sonnet, ONE_CALL); // routed to Gemini by the override
    rec.flush(1);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.provider).toBe('gemini');
    expect(row.priceStatus).toBe('pricing_unknown');
    expect(row.costCents).toBeNull();
  });

  it('lets an explicit setMeta({ provider }) override the derived label', () => {
    delete process.env.AEGIS_BRAIN;
    const rec = new UsageRecorder('t-x', 'v');
    rec.cost.add(MODEL_IDS.sonnet, ONE_CALL);
    rec.setMeta({ provider: 'chatgpt-codex' });
    rec.flush(1);
    expect(mockLogUsage.mock.calls[0][0].provider).toBe('chatgpt-codex');
  });

  it('records provider="mixed" (never a silent single brand) if a run spans providers', () => {
    delete process.env.AEGIS_BRAIN;
    const rec = new UsageRecorder('t-m', 'v');
    rec.cost.addRef({ provider: 'anthropic', model: MODEL_IDS.sonnet }, ONE_CALL);
    rec.cost.addRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, ONE_CALL);
    rec.flush(1);
    const row = mockLogUsage.mock.calls[0][0];
    expect(row.provider).toBe('mixed');
    // Worst-status-wins already tainted the cost to unpriced (null), independently.
    expect(row.priceStatus).toBe('pricing_unknown');
    expect(row.costCents).toBeNull();
  });
});
