import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostAccumulator } from '../context/cost';
import { getModeSpec } from '../modes';
import { MODEL_IDS } from '../types';

vi.mock('../client', () => ({
  callClaude: vi.fn(),
  callHaiku: vi.fn(),
}));

import { callClaude } from '../client';
import { runOuterLoop, type LoopState } from '../loop';
import {
  CONTINUATION_TIME_FLOOR_MS,
  FINALIZE_RESERVE_MS,
  GEN_TOKENS_PER_SEC,
  MIN_CALL_TOKENS,
  REPAIR_RESERVE_MS,
  RETRY_RESERVE_MS,
  budgetedMaxTokens,
} from '../degrade';

const mockCallClaude = vi.mocked(callClaude);

const NOW = 1_000_000;

/** LoopState whose remaining wall-clock (after the finalize buffer) is `timeLeft` ms. */
function stateWithTimeLeft(timeLeft: number): LoopState {
  return {
    messages: [{ role: 'user', content: 'Was sind die DORA-Anforderungen?' }],
    iteration: 0,
    cost: new CostAccumulator(),
    toolCalls: [],
    toolsCalled: 0,
    allowedIds: new Set<string>(['R-DORA-001']),
    servedModels: new Set<string>(),
    guardrailsTriggered: [],
    now: () => NOW,
    deadlineAt: NOW + FINALIZE_RESERVE_MS + timeLeft,
  };
}

function message(text: string, stopReason: 'end_turn' | 'max_tokens'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

beforeEach(() => {
  mockCallClaude.mockReset();
});

// ───────────────────────── budgetedMaxTokens (c) ─────────────────────────

describe('budgetedMaxTokens', () => {
  it('passes the spec ceiling through when there is no deadline (Infinity)', () => {
    expect(budgetedMaxTokens(8192, Number.POSITIVE_INFINITY)).toBe(8192);
  });

  it('shrinks max_tokens to what fits in the remaining time', () => {
    // 100 s × 40 tok/s = 4000 — between floor and cap.
    expect(budgetedMaxTokens(8192, 100_000)).toBe(100 * GEN_TOKENS_PER_SEC);
  });

  it('never goes below the floor', () => {
    // 30 s × 40 = 1200 < 2048 → floor.
    expect(budgetedMaxTokens(8192, 30_000)).toBe(MIN_CALL_TOKENS);
    expect(budgetedMaxTokens(8192, 0)).toBe(MIN_CALL_TOKENS);
  });

  it('never exceeds the mode ceiling', () => {
    // 600 s × 40 = 24000 > 8192 → cap.
    expect(budgetedMaxTokens(8192, 600_000)).toBe(8192);
  });

  it('is applied to the actual Claude call', async () => {
    mockCallClaude.mockResolvedValueOnce(
      message('DORA regelt die digitale Betriebsstabilität. [R-DORA-001]', 'end_turn'),
    );
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    await runOuterLoop(spec, stateWithTimeLeft(100_000), MODEL_IDS.sonnet, 'de');
    expect(mockCallClaude.mock.calls[0][0].maxTokens).toBe(100 * GEN_TOKENS_PER_SEC);
  });
});

// ───────────────────────── continuation gate (a) ─────────────────────────

describe('max_tokens continuation time gate', () => {
  it('skips the continuation and appends the note when too little time remains', async () => {
    // Below the continuation floor, but the max_tokens stop would normally continue.
    const timeLeft = CONTINUATION_TIME_FLOOR_MS - 10_000;
    mockCallClaude.mockResolvedValue(
      message('DORA regelt die digitale Betriebsstabilität. [R-DORA-001]', 'max_tokens'),
    );
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(timeLeft);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    // Exactly ONE call — no continuation was started.
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('automatischer Fortsetzungen');
    expect(state.guardrailsTriggered).toContain('continuation_time_gated');
    expect(state.guardrailsTriggered).not.toContain('max_tokens_continued');
  });

  it('still continues normally with ample time (regression)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(message('DORA regelt die digitale ', 'max_tokens'))
      .mockResolvedValueOnce(message('Betriebsstabilität. [R-DORA-001]', 'end_turn'));
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(CONTINUATION_TIME_FLOOR_MS + 120_000);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('digitale Betriebsstabilität');
    expect(state.guardrailsTriggered).toContain('max_tokens_continued');
    expect(state.guardrailsTriggered).not.toContain('continuation_time_gated');
  });
});

// ───────────────────────── retry gate (b) ─────────────────────────

describe('outer-loop retry time gate (all failure types)', () => {
  it('blocks the full retry for a non-citation failure when time is short', async () => {
    // ≥ REPAIR_RESERVE (regulation repair still runs) but < RETRY_RESERVE.
    const timeLeft = Math.floor((REPAIR_RESERVE_MS + RETRY_RESERVE_MS) / 2);
    // Unknown standard → no_hallucinated_regulations on every attempt.
    mockCallClaude.mockResolvedValue(
      message('Der Standard ISO 99999 ist hier maßgeblich. [R-DORA-001]', 'end_turn'),
    );
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(timeLeft);

    await expect(runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de')).rejects.toMatchObject({
      code: 'verify_failed',
    });

    // gen + ONE regulation repair — the full re-generation retry never started.
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(state.guardrailsTriggered).toContain('regulation_repair_tried');
    expect(state.guardrailsTriggered).toContain('retry_time_gated');
  });

  it('still retries with ample time (regression)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(message('Der Standard ISO 99999 ist maßgeblich.', 'end_turn'))
      .mockResolvedValueOnce(message('Der Standard ISO 99999 ist maßgeblich.', 'end_turn')) // repair fails
      .mockResolvedValueOnce(message('DORA regelt das. [R-DORA-001]', 'end_turn')); // retry passes
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(RETRY_RESERVE_MS + 300_000);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(3);
    expect(state.guardrailsTriggered).not.toContain('retry_time_gated');
  });
});
