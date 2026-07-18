import { beforeEach, describe, expect, it, vi } from 'vitest';

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
