import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostAccumulator } from '../context/cost';
import { getModeSpec } from '../modes';
import { MODEL_IDS } from '../types';
import { MemoryConfig } from '../memory-config';

/** A reported input-token count guaranteed to exceed the compaction trigger. */
const OVER_COMPACTION_TOKENS = MemoryConfig.autoCompactionTokens + 10_000;

// Mock the entire client module so the loop never touches the real Anthropic SDK.
vi.mock('../client', () => ({
  callClaude: vi.fn(),
  callHaiku: vi.fn(),
}));

// Import AFTER the mock so the loop picks up our stubs.
import { callClaude, callHaiku } from '../client';
import { monetaryCostCapApplies, runOuterLoop, trimForRetry, type LoopState } from '../loop';
import {
  REPAIR_RESERVE_MS,
  RETRY_RESERVE_MS,
  FINALIZE_RESERVE_MS,
} from '../degrade';

const mockCallClaude = vi.mocked(callClaude);
const mockCallHaiku = vi.mocked(callHaiku);

// ───────────────────────── Fixtures ─────────────────────────

function makeState(message = 'Was sind die DORA-Anforderungen?'): LoopState {
  return {
    messages: [{ role: 'user', content: message }],
    iteration: 0,
    cost: new CostAccumulator(),
    toolCalls: [],
    toolsCalled: 0,
    // Seed a valid, KB-resolving id so the grounded fixture answers (which cite
    // [R-AIACT-001]) pass citation_coverage + the new unsupported_regulatory_claim
    // check without needing a tool call. Tool-sourced ids (e.g. R-AIACT-005) are
    // still added on top, so tool-attribution assertions stay meaningful.
    allowedIds: new Set<string>(['R-AIACT-001']),
    servedModels: new Set<string>(),
    guardrailsTriggered: [],
  };
}

describe('monetaryCostCapApplies — the $-cap only binds on a priced run', () => {
  const USAGE = { input_tokens: 100, output_tokens: 50 };

  it('applies on a priced Anthropic run, recording no unavailability marker', () => {
    const state = makeState();
    state.cost.add(MODEL_IDS.sonnet, USAGE); // anthropic → priced
    expect(monetaryCostCapApplies(state)).toBe(true);
    expect(state.guardrailsTriggered).not.toContain('cost_cap_unavailable');
  });

  it('is unavailable on an unpriced run and marks it exactly once (never a silent $0)', () => {
    const state = makeState();
    state.cost.addRef({ provider: 'gemini', model: 'gemini-2.5-pro' }, USAGE); // pricing_unknown
    expect(monetaryCostCapApplies(state)).toBe(false);
    expect(monetaryCostCapApplies(state)).toBe(false); // idempotent across iterations
    expect(state.guardrailsTriggered.filter((g) => g === 'cost_cap_unavailable')).toHaveLength(1);
  });
});

function makeMessage(opts: {
  text?: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  inputTokens?: number;
  outputTokens?: number;
}): Anthropic.Message {
  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];
  if (opts.text) {
    content.push({
      type: 'text',
      text: opts.text,
      citations: null,
    } as Anthropic.TextBlock);
  }
  for (const t of opts.toolUse ?? []) {
    content.push({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input: t.input,
    } as Anthropic.ToolUseBlock);
  }
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: content as Anthropic.ContentBlock[],
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

beforeEach(() => {
  mockCallClaude.mockReset();
  mockCallHaiku.mockReset();
});

// ───────────────────────── Inner loop happy paths ─────────────────────────

describe('runOuterLoop — happy paths', () => {
  it('end_turn on first call → returns text + verify ok', async () => {
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
      }),
    );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.text).toContain('DORA');
    expect(result.state.iteration).toBe(0);
    expect(result.state.toolsCalled).toBe(0);
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('tool_use → execute → end_turn populates allowedIds and returns', async () => {
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [
            { id: 't1', name: 'search_kb', input: { query: 'R-AIACT-005' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'Die Verordnung enthält Verbote für KI-Systeme und gilt für alle Anbieter und Betreiber.',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.state.toolsCalled).toBe(1);
    expect(result.state.toolCalls[0].name).toBe('search_kb');
    // search_kb returns R-AIACT-005 as an exact ID match → added to allowedIds.
    expect(result.state.allowedIds.has('R-AIACT-005')).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────── citation-repair fast-retry ─────────────────────────

describe('runOuterLoop — citation-repair fast-retry', () => {
  function stateWith(ids: string[]): LoopState {
    return { ...makeState(), allowedIds: new Set(ids) };
  }

  it('repairs an uncited article reference with ONE tool-free call (no full re-generation)', async () => {
    mockCallClaude
      // attempt 1 — names an article but cites nothing → fails citation_coverage
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA regelt den Anwendungsbereich (Art. 1).' }))
      // repair call — same answer, now with the matching (already-retrieved) ID
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA regelt den Anwendungsbereich (Art. 1) [R-DORA-001].' }));

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-DORA-001']), MODEL_IDS.sonnet, 'de');

    expect(result.text).toContain('[R-DORA-001]');
    expect(result.verify.ok).toBe(true);
    // exactly: 1 generation + 1 repair — NO expensive full re-generation retry.
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.state.guardrailsTriggered).toContain('citation_repaired');
  });

  it('is regulation-agnostic (works for EU AI Act the same way)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'Der EU AI Act verbietet bestimmte Praktiken (Art. 5).' }))
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'Der EU AI Act verbietet bestimmte Praktiken (Art. 5) [R-AIACT-005].' }));

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-AIACT-005']), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.text).toContain('[R-AIACT-005]');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('falls back to the full retry when the repair still fails', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA gilt ab 2025 (Art. 1).' })) // attempt 1: uncited
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA gilt ab 2025 (Art. 1).' })) // repair: STILL uncited → reverify fails
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA gilt ab 2025 (Art. 1) [R-DORA-001].' })); // full-retry regen: now passes

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-DORA-001']), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(3); // gen + failed repair + full retry
    expect(result.state.guardrailsTriggered).toContain('citation_repair_tried');
    expect(result.state.guardrailsTriggered).not.toContain('citation_repaired');
  });

  it('attempts the repair at most once per turn', async () => {
    // Both the generation and the repair stay uncited; with maxAttempts the run
    // ends in verify_failed, but the repair must have fired exactly once.
    mockCallClaude.mockResolvedValue(makeMessage({ stopReason: 'end_turn', text: 'DORA gilt (Art. 1).' }));
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWith(['R-DORA-001']);
    await expect(runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de')).rejects.toMatchObject({ code: 'verify_failed' });
    expect(state.guardrailsTriggered.filter((g) => g === 'citation_repair_tried')).toHaveLength(1);
  });
});

// ───────────────────────── regulation-name-repair fast-retry ─────────────────────────

describe('runOuterLoop — regulation-name-repair fast-retry', () => {
  function stateWith(ids: string[]): LoopState {
    return { ...makeState(), allowedIds: new Set(ids) };
  }
  // Fails ONLY no_hallucinated_regulations: no bare Art./§ refs, valid citation,
  // but names a standard (ISO 27001) that is not in the KB whitelist.
  const HALLUC_TEXT =
    'Ergänzend zu DORA [R-DORA-001] ist ISO 27001 für das Secrets Management relevant.';
  const REPAIRED_TEXT =
    'Ergänzend zu DORA [R-DORA-001] ist ein etablierter Informationssicherheits-Standard für das Secrets Management relevant.';

  it('repairs an unknown regulation name with ONE tool-free call (no full re-generation)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT }))
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: REPAIRED_TEXT }));

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-DORA-001']), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.text).not.toContain('ISO 27001');
    // exactly: 1 generation + 1 repair — NO expensive full re-generation retry.
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.state.guardrailsTriggered).toContain('regulation_repaired');
  });

  it('falls back to the full retry when the repair still fails', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT })) // attempt 1
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT })) // repair: STILL unknown name
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: REPAIRED_TEXT })); // full-retry regen passes

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-DORA-001']), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(3); // gen + failed repair + full retry
    expect(result.state.guardrailsTriggered).toContain('regulation_repair_tried');
    expect(result.state.guardrailsTriggered).not.toContain('regulation_repaired');
  });

  it('attempts the repair at most once per turn', async () => {
    mockCallClaude.mockResolvedValue(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT }));
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWith(['R-DORA-001']);
    await expect(runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de')).rejects.toMatchObject({ code: 'verify_failed' });
    expect(state.guardrailsTriggered.filter((g) => g === 'regulation_repair_tried')).toHaveLength(1);
  });

  it('catches a repair that substitutes a different KNOWN standard without citation (re-verify fails → full retry)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT })) // attempt 1: ISO 27001
      // Repair violates the nudge: swaps in ISO 42001 (known to the KB) but cites
      // nothing — must fail unsupported_regulatory_claim on re-verify, never ship.
      .mockResolvedValueOnce(
        makeMessage({ stopReason: 'end_turn', text: 'Für das Secrets Management ist ISO 42001 maßgeblich.' }),
      )
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: REPAIRED_TEXT })); // full-retry regen passes

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, stateWith(['R-DORA-001']), MODEL_IDS.sonnet, 'de');

    expect(mockCallClaude).toHaveBeenCalledTimes(3); // gen + rejected repair + full retry
    expect(result.state.guardrailsTriggered).toContain('regulation_repair_tried');
    expect(result.state.guardrailsTriggered).not.toContain('regulation_repaired');
    expect(result.verify.ok).toBe(true);
    expect(result.text).not.toContain('ISO 42001');
  });

  it('skips the repair under time pressure (no degrade banner — hallucination check stays hard)', async () => {
    const NOW = 1_000_000;
    mockCallClaude.mockResolvedValue(makeMessage({ stopReason: 'end_turn', text: HALLUC_TEXT }));
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state: LoopState = {
      ...makeState(),
      allowedIds: new Set(['R-DORA-001']),
      now: () => NOW,
      deadlineAt: NOW + FINALIZE_RESERVE_MS + REPAIR_RESERVE_MS - 5_000,
    };

    await expect(runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de')).rejects.toMatchObject({
      code: 'verify_failed',
    });
    expect(state.guardrailsTriggered).not.toContain('regulation_repair_tried');
    expect(state.verifyDegraded).toBeFalsy();
  });
});

// ───────────────────────── time-budget degradation (A) ─────────────────────────

describe('runOuterLoop — time-budget graceful degradation', () => {
  const NOW = 1_000_000;
  // Build a state whose remaining wall-clock (after the finalize buffer) is
  // exactly `timeLeft` ms, with a frozen injected clock.
  function stateWithTimeLeft(ids: string[], timeLeft: number): LoopState {
    return {
      ...makeState(),
      allowedIds: new Set(ids),
      now: () => NOW,
      deadlineAt: NOW + FINALIZE_RESERVE_MS + timeLeft,
    };
  }
  const uncited = () => makeMessage({ stopReason: 'end_turn', text: 'DORA gilt (Art. 1).' });

  it('degrades (banner, NO repair, NO retry) when too little time for any recovery', async () => {
    mockCallClaude.mockResolvedValue(uncited());
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(['R-DORA-001'], REPAIR_RESERVE_MS - 5_000);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    // Only the initial generation ran — no repair call, no full re-generation.
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    // Never a verified success: verify stays false, surfaced as degraded:'verify'.
    expect(result.verify.ok).toBe(false);
    expect(result.state.verifyDegraded).toBe(true);
    expect(result.state.guardrailsTriggered).toContain('verify_degraded');
    expect(result.state.guardrailsTriggered).not.toContain('citation_repair_tried');
    // The complete report is preserved, with an explicit banner prepended.
    expect(result.text).toMatch(/Verifizierung unvollständig/);
    expect(result.text).toContain('DORA gilt (Art. 1).');
  });

  it('tries the cheap repair, then degrades when there is no time for a full retry', async () => {
    mockCallClaude.mockResolvedValue(uncited()); // generation AND repair stay uncited
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const timeLeft = Math.floor((REPAIR_RESERVE_MS + RETRY_RESERVE_MS) / 2); // ≥ repair, < retry
    const state = stateWithTimeLeft(['R-DORA-001'], timeLeft);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    // gen + exactly one repair, but NO expensive full re-generation retry.
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(result.state.guardrailsTriggered).toContain('citation_repair_tried');
    expect(result.state.verifyDegraded).toBe(true);
    expect(result.text).toMatch(/Verifizierung unvollständig/);
  });

  it('leaves the happy path unchanged when there is ample time (repair fixes citations, no degradation)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(uncited())
      .mockResolvedValueOnce(makeMessage({ stopReason: 'end_turn', text: 'DORA gilt (Art. 1) [R-DORA-001].' }));
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(['R-DORA-001'], RETRY_RESERVE_MS + 30_000);

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.state.verifyDegraded).toBeFalsy();
    expect(result.text).toContain('[R-DORA-001]');
    expect(result.text).not.toMatch(/Verifizierung unvollständig/);
    expect(mockCallClaude).toHaveBeenCalledTimes(2); // gen + repair
  });

  it('does NOT degrade a hallucinated-regulation failure under time pressure (hallucination protection intact)', async () => {
    // Non-citation-family failure (no_hallucinated_regulations) → must still hard-fail,
    // never be shown with a banner, even with no time left.
    mockCallClaude.mockResolvedValue(
      makeMessage({ stopReason: 'end_turn', text: 'Der Standard ISO 99999 ist hier maßgeblich.' }),
    );
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = stateWithTimeLeft(['R-DORA-001'], 1_000); // effectively no time

    await expect(runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de')).rejects.toMatchObject({
      code: 'verify_failed',
    });
    expect(state.verifyDegraded).toBeFalsy();
    expect(state.guardrailsTriggered).not.toContain('verify_degraded');
  });
});

// ───────────────────────── max_tokens continuation (3.3) ─────────────────────────

describe('runOuterLoop — max_tokens continuation', () => {
  it('continues once on max_tokens and joins part 1 + part 2', async () => {
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'max_tokens',
          text: 'Die DORA-Verordnung regelt die digitale Betriebsstabilität ',
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'und gilt seit 2025 für alle Finanzunternehmen in der EU. [R-AIACT-001]',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.text).toContain('digitale Betriebsstabilität');
    expect(result.text).toContain('alle Finanzunternehmen');
    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    // Continuation does not consume a tool iteration.
    expect(result.state.iteration).toBe(0);
    expect(result.state.guardrailsTriggered).toContain('max_tokens_continued');
  });

  it('continues across multiple max_tokens stops and joins all parts once (no duplication)', async () => {
    mockCallClaude
      .mockResolvedValueOnce(makeMessage({ stopReason: 'max_tokens', text: 'Teil-eins ' }))
      .mockResolvedValueOnce(makeMessage({ stopReason: 'max_tokens', text: 'Teil-zwei ' }))
      .mockResolvedValueOnce(
        makeMessage({ stopReason: 'end_turn', text: 'Teil-drei. [R-AIACT-001]' }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.text).toContain('Teil-eins');
    expect(result.text).toContain('Teil-zwei');
    expect(result.text).toContain('Teil-drei');
    // Two continuations (within the default cap of 3); no part repeated.
    expect(mockCallClaude).toHaveBeenCalledTimes(3);
    expect(result.text.match(/Teil-eins/g)).toHaveLength(1);
    expect(
      result.state.guardrailsTriggered.filter((g) => g === 'max_tokens_continued'),
    ).toHaveLength(2);
  });

  it('appends an explicit closing note when continuations are exhausted (no silent truncation)', async () => {
    // 4 consecutive max_tokens → 3 continuations (default cap), then the 4th is
    // accepted with a visible "report ended after N continuations" note.
    for (let i = 0; i < 4; i++) {
      mockCallClaude.mockResolvedValueOnce(
        makeMessage({ stopReason: 'max_tokens', text: `Abschnitt-${i} [R-AIACT-001] ` }),
      );
    }

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(mockCallClaude).toHaveBeenCalledTimes(4);
    expect(
      result.state.guardrailsTriggered.filter((g) => g === 'max_tokens_continued'),
    ).toHaveLength(3);
    expect(result.text).toMatch(/maximalen Anzahl automatischer Fortsetzungen/);
  });

  it('does not re-send a dangling tool_use when truncated mid-tool-call (regression: Anthropic 400)', async () => {
    // The model starts a tool call but the turn is cut by max_tokens. The
    // continuation must seed only the TEXT so far — re-sending the partial
    // tool_use followed by a plain-text nudge is the exact shape Anthropic
    // rejects with `tool_use ids ... without tool_result`.
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'max_tokens',
          text: 'Ich prüfe das kurz in der Wissensbasis. ',
          toolUse: [{ id: 'toolu_partial', name: 'search_kb', input: { query: 'DORA' } }],
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'DORA gilt seit 2025 für Finanzunternehmen in der EU. [R-AIACT-001]',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.text).toContain('DORA gilt seit 2025');
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    // No assistant turn in the continuation request may carry a tool_use block.
    const continuationMessages = mockCallClaude.mock.calls[1][0].messages;
    const hasDanglingToolUse = continuationMessages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type: string }).type === 'tool_use'),
    );
    expect(hasDanglingToolUse).toBe(false);
    expect(result.state.guardrailsTriggered).toContain('max_tokens_continued');
  });
});

// ───────────────────────── graceful degradation (3.1) ─────────────────────────

describe('runOuterLoop — graceful degradation', () => {
  const validAnswer =
    'Die DORA-Verordnung gilt seit 2025 für alle Finanzunternehmen in der EU. [R-AIACT-001]';

  it('forces a tool-free answer at the iteration ceiling instead of throwing', async () => {
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = makeState();
    state.iteration = spec.maxIterations - 1; // one short of the ceiling

    mockCallClaude.mockResolvedValueOnce(
      makeMessage({ stopReason: 'end_turn', text: validAnswer }),
    );

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(result.text).toContain('DORA');
    expect(result.state.forcedAnswer).toBe('iteration');
    expect(result.state.guardrailsTriggered).toContain('forced_answer:iteration');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    // tools array kept intact; only tool_choice flips to none (cache-stable).
    expect(mockCallClaude.mock.calls[0][0].toolChoice).toEqual({ type: 'none' });
    expect(mockCallClaude.mock.calls[0][0].tools.length).toBeGreaterThan(0);
  });

  it('forces a tool-free answer when within ~20% of the cost cap', async () => {
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const state = makeState();
    // Pre-charge well past 0.8 × maxCostUsd so the degrade check fires at once.
    state.cost.add(MODEL_IDS.sonnet, {
      input_tokens: 50_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    mockCallClaude.mockResolvedValueOnce(
      makeMessage({ stopReason: 'end_turn', text: validAnswer }),
    );

    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(result.state.forcedAnswer).toBe('cost');
    expect(result.state.guardrailsTriggered).toContain('forced_answer:cost');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(mockCallClaude.mock.calls[0][0].toolChoice).toEqual({ type: 'none' });
  });

  it('does not force when there is iteration and cost headroom', async () => {
    const spec = getModeSpec('CONVERSATIONAL', 'de');
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({ stopReason: 'end_turn', text: validAnswer }),
    );
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');
    expect(result.state.forcedAnswer).toBeUndefined();
    expect(mockCallClaude.mock.calls[0][0].toolChoice).toBeUndefined();
  });
});

// ───────────────────────── tiered verify (3.2) ─────────────────────────

describe('runOuterLoop — tiered verify', () => {
  it('soft-only failure → warn-and-return without retrying', async () => {
    // English answer while language is 'de' → language_consistency (soft) fails;
    // no hard check trips, so the loop must accept with a warning, not retry.
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'The DORA regulation applies to all financial entities and is binding in the EU. [R-AIACT-001]',
      }),
    );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    if (result.verify.ok) {
      expect(result.verify.warnings?.[0]?.check).toBe('language_consistency');
    }
    // No retry — exactly one model call.
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(result.state.guardrailsTriggered).toContain('soft_warn:language_consistency');
  });

  it('hard failure still retries and recovers', async () => {
    mockCallClaude
      .mockResolvedValueOnce(
        // Uncited Art. ref → citation_coverage (hard) fails.
        makeMessage({
          stopReason: 'end_turn',
          text: 'Art. 5 enthält Verbote für KI-Systeme im Finanzsektor der EU.',
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'Die DORA-Verordnung gilt seit 2025 für alle Finanzunternehmen in der EU. [R-AIACT-001]',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2); // retried
  });
});

// ───────────────────────── Verify retry ─────────────────────────

describe('runOuterLoop — verify retry', () => {
  it('first response fails verify, retry succeeds', async () => {
    mockCallClaude
      .mockResolvedValueOnce(
        // Uncited Art. reference → citation_coverage fails.
        makeMessage({
          stopReason: 'end_turn',
          text: 'Art. 5 enthält wichtige Verbote für KI-Systeme im Finanzsektor der EU.',
        }),
      )
      .mockResolvedValueOnce(
        // Clean response → verify passes.
        makeMessage({
          stopReason: 'end_turn',
          text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it('three verify failures throw verify_failed', async () => {
    const bad = () =>
      makeMessage({
        stopReason: 'end_turn',
        text: 'Art. 5 enthält Verbote ohne jegliche Citation und § 8 wird auch genannt.',
      });
    // Every generation AND the one-shot citation repair stay uncited.
    mockCallClaude.mockResolvedValue(bad());

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    await expect(
      runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de'),
    ).rejects.toMatchObject({ code: 'verify_failed' });

    // 3 generations + exactly one (failed) tool-free citation-repair call.
    expect(mockCallClaude).toHaveBeenCalledTimes(4);
  });
});

// ───────────────────────── Hard limits ─────────────────────────

describe('runOuterLoop — hard limits', () => {
  it('forces an answer (3.1) instead of throwing iteration_limit when tool_use keeps coming', async () => {
    // Endless tool_use responses; the forced final call (tool_choice:none) is
    // the one that returns text. With 3.1 the loop degrades gracefully instead
    // of throwing iteration_limit and discarding the spend.
    mockCallClaude.mockImplementation(async (params) => {
      if (params.toolChoice) {
        return makeMessage({
          stopReason: 'end_turn',
          text: 'Die DORA-Verordnung gilt seit 2025 für alle Finanzunternehmen in der EU. [R-AIACT-001]',
        });
      }
      return makeMessage({
        stopReason: 'tool_use',
        toolUse: [{ id: 't', name: 'search_kb', input: { query: 'R-AIACT-005' } }],
      });
    });

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.state.forcedAnswer).toBe('iteration');
    expect(result.text).toContain('DORA');
    expect(result.verify.ok).toBe(true);
  });

  it('per-mode ceiling: a mode with maxIterations > 10 runs past 10 iterations', async () => {
    // ASSESS allows 15 iterations. Old behaviour: the pre-guard killed at the
    // global default of 10 → non-retryable iteration_limit before the mode's
    // own ceiling. Now the guard uses spec.maxIterations, so 11 tool iterations
    // are allowed and the run completes.
    for (let i = 0; i < 11; i++) {
      mockCallClaude.mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [{ id: `t${i}`, name: 'search_kb', input: { query: 'R-AIACT-005' } }],
        }),
      );
    }
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'Die Bewertung wurde vollständig durchgeführt und alle relevanten Anforderungen sind geprüft worden.',
      }),
    );

    const spec = getModeSpec('ASSESS', 'de'); // maxIterations = 15
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.state.iteration).toBe(11); // past the old global ceiling of 10
    expect(mockCallClaude).toHaveBeenCalledTimes(12);
  });

  it('upstream_error on unexpected stop_reason', async () => {
    mockCallClaude.mockResolvedValueOnce({
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: 'refusal',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } as Anthropic.Usage,
    } as unknown as Anthropic.Message);

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    await expect(
      runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de'),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

// ───────────────────────── ASSESS mode (KB-first reasoning) ─────────────────────────

describe('runOuterLoop — ASSESS (KB-first reasoning)', () => {
  it('ASSESS completes via search_kb + get_crosswalk only', async () => {
    // Real search_kb is executed (only callClaude is mocked). Queries are
    // chosen so the tools actually return the IDs the final response cites,
    // letting verify.citation_coverage pass without a retry.
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [
            // Query "GDPR" returns R-GDPR-005, R-GDPR-006, R-GDPR-009, R-GDPR-012, R-GDPR-013.
            { id: 't1', name: 'search_kb', input: { query: 'GDPR' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [
            { id: 't2', name: 'get_crosswalk', input: { topic: 'governance' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text:
            'Die Rechtsgrundlage für die Verarbeitung personenbezogener Daten ist ' +
            '[R-GDPR-006] und die Informationspflichten sind in [R-GDPR-013] geregelt. ' +
            'Das Risikoniveau für KI-gestützte Kundenfeedback-Analyse ist limited.\n\n' +
            'Quellen: R-GDPR-006, R-GDPR-013',
        }),
      );

    const spec = getModeSpec('ASSESS', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    expect(result.state.toolsCalled).toBe(2);
    const toolNames = result.state.toolCalls.map((c) => c.name);
    expect(toolNames).toContain('search_kb');
    expect(toolNames).toContain('get_crosswalk');
    expect(toolNames).toHaveLength(2);
  });
});

// ───────────────────────── Cost tracking ─────────────────────────

describe('runOuterLoop — cost tracking', () => {
  it('accumulates tokens from the response usage into state.cost', async () => {
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
        inputTokens: 1000,
        outputTokens: 200,
      }),
    );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    const bd = result.state.cost.breakdown();
    expect(bd.inputTokens).toBe(1000);
    expect(bd.outputTokens).toBe(200);
    expect(bd.usd).toBeGreaterThan(0);
  });
});

// ───────────────────────── Observability (Phase 2) ─────────────────────────

describe('runOuterLoop — served model capture (C)', () => {
  it('records the served model (response.model) into state.servedModels', async () => {
    // makeMessage stamps model: 'claude-sonnet-4-6' as the served model.
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
      }),
    );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect([...result.state.servedModels]).toEqual(['claude-sonnet-4-6']);
  });
});

describe('runOuterLoop — guardrail observability (D)', () => {
  it('records `compress` in guardrailsTriggered when the token budget is exceeded', async () => {
    // Call 1 reports a huge prompt → the next pre-guard sees
    // contextTokens > maxContextTokens (the compaction trigger) and returns `compress`.
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [{ id: 't1', name: 'search_kb', input: { query: 'DORA' } }],
          inputTokens: OVER_COMPACTION_TOKENS,
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.state.guardrailsTriggered).toContain('compress');
  });
});

// ───────────────────────── Token-budget compaction (F) ─────────────────────────

describe('runOuterLoop — token-budget compaction (F)', () => {
  it('does NOT compact on the first call (iteration 0, no prior token count)', async () => {
    // currentContextTokens() is 0 before any call → no compaction on call 1,
    // regardless of how many seed messages there are.
    mockCallClaude.mockResolvedValueOnce(
      makeMessage({
        stopReason: 'end_turn',
        text: 'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend in der EU. [R-AIACT-001]',
      }),
    );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.state.guardrailsTriggered).not.toContain('compress');
    expect(mockCallHaiku).not.toHaveBeenCalled(); // compressContext never ran
  });
});

// ─────────────── Compaction keeps tool_use/tool_result paired (regression) ───────────────

describe('runOuterLoop — compaction does not orphan tool pairs (Anthropic 400 regression)', () => {
  function pairingOk(msgs: Anthropic.MessageParam[]): boolean {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const useIds = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
        if (useIds.length > 0) {
          const next = msgs[i + 1];
          const resIds = (next && Array.isArray(next.content) ? next.content : [])
            .filter((b) => b.type === 'tool_result')
            .map((b) => (b as { tool_use_id: string }).tool_use_id);
          if (next?.role !== 'user' || !useIds.every((id) => resIds.includes(id))) return false;
        }
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue;
          const prev = msgs[i - 1];
          const useIds = (prev && Array.isArray(prev.content) ? prev.content : [])
            .filter((x) => x.type === 'tool_use')
            .map((x) => (x as { id: string }).id);
          if (!useIds.includes(b.tool_use_id)) return false;
        }
      }
    }
    return true;
  }

  it('parallel-tool turn + compaction → post-compaction messages stay API-valid', async () => {
    const tu = (...ids: string[]): Anthropic.MessageParam => ({
      role: 'assistant',
      content: ids.map((id) => ({ type: 'tool_use', id, name: 'search_kb', input: {} })),
    });
    const tr = (...ids: string[]): Anthropic.MessageParam => ({
      role: 'user',
      content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
    });
    // Long seeded history with an EARLY parallel tool_use pair at idx 1-2 — the
    // head/middle boundary (anchor 2) lands exactly on the pair (the orphaning case).
    const state: LoopState = {
      messages: [
        { role: 'user', content: 'Erste Frage zu DORA' },
        tu('h1', 'h2'),
        tr('h1', 'h2'),
        { role: 'assistant', content: 'Zwischenantwort 1' },
        { role: 'user', content: 'Folgefrage' },
        { role: 'assistant', content: 'Zwischenantwort 2' },
        { role: 'user', content: 'Noch eine Frage' },
      ],
      iteration: 0,
      cost: new CostAccumulator(),
      toolCalls: [],
      toolsCalled: 0,
      allowedIds: new Set<string>(['R-AIACT-001']),
      servedModels: new Set<string>(),
      guardrailsTriggered: [],
    };
    // call 1 reports a huge prompt → next pre-guard triggers compaction.
    mockCallHaiku.mockResolvedValue({
      text: 'Zusammenfassung des mittleren Gesprächsteils.',
      usage: { input_tokens: 500, output_tokens: 60 },
    });
    mockCallClaude
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [
            { id: 't1', name: 'search_kb', input: { query: 'DORA' } },
            { id: 't2', name: 'search_kb', input: { query: 'NIS2' } },
          ],
          inputTokens: OVER_COMPACTION_TOKENS,
        }),
      )
      .mockResolvedValueOnce(
        makeMessage({ stopReason: 'end_turn', text: 'Finale Antwort. [R-AIACT-001]' }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, state, MODEL_IDS.sonnet, 'de');

    expect(result.state.guardrailsTriggered).toContain('compress');
    expect(mockCallHaiku).toHaveBeenCalled(); // real summarize path ran
    // The 2nd callClaude received the post-compaction messages — must be API-valid
    // (no dangling tool_use, no orphaned tool_result) or Anthropic would 400.
    const sentToCall2 = mockCallClaude.mock.calls[1]![0].messages as Anthropic.MessageParam[];
    expect(pairingOk(sentToCall2)).toBe(true);
  });
});

// ───────────────────────── Verify-retry trimming (G) ─────────────────────────

function toolResultMsg(id: string, content: string): Anthropic.MessageParam {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

describe('trimForRetry (G)', () => {
  it('produces an API-valid sequence with NO orphaned tool_result blocks', () => {
    const seed: Anthropic.MessageParam[] = [{ role: 'user', content: 'Was gilt für DORA?' }];
    const current: Anthropic.MessageParam[] = [
      ...seed,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_kb', input: {} }] },
      toolResultMsg('t1', 'Treffer: R-AIACT-005 — Verbote für KI-Systeme.'),
    ];
    const allowedIds = new Set(['R-AIACT-005']);

    const out = trimForRetry(seed, current, allowedIds, 'falsche Antwort', '[VERIFY FEEDBACK] fix it');

    // Every kept message is plain text → no tool_result (and no tool_use) blocks at all.
    const hasToolBlocks = out.some(
      (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result' || b.type === 'tool_use'),
    );
    expect(hasToolBlocks).toBe(false);
    expect(out.every((m) => typeof m.content === 'string')).toBe(true);
  });

  it('keeps the question, prior answer, and allowedId-backed evidence; leaves allowedIds untouched', () => {
    const seed: Anthropic.MessageParam[] = [{ role: 'user', content: 'Was gilt für DORA?' }];
    const current: Anthropic.MessageParam[] = [
      ...seed,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_kb', input: {} }] },
      toolResultMsg('t1', 'Treffer: R-AIACT-005 — Verbote.'),
      toolResultMsg('t2', 'Irrelevanter Treffer ohne ID.'),
    ];
    const allowedIds = new Set(['R-AIACT-005']);

    const out = trimForRetry(seed, current, allowedIds, 'meine falsche Antwort', '[VERIFY FEEDBACK] korrigiere');
    const blob = JSON.stringify(out);

    expect(blob).toContain('Was gilt für DORA?');         // question kept
    expect(blob).toContain('meine falsche Antwort');       // prior answer kept (assistant turn)
    expect(blob).toContain('R-AIACT-005');                 // evidence (allowedId-backed) kept
    expect(blob).toContain('[VERIFY FEEDBACK]');           // feedback kept
    // allowedIds is a separate Set — untouched by the trim.
    expect([...allowedIds]).toEqual(['R-AIACT-005']);
  });

  it('floor: with no allowedId-backed evidence, keeps the most recent tool_result batch', () => {
    const seed: Anthropic.MessageParam[] = [{ role: 'user', content: 'Frage' }];
    const current: Anthropic.MessageParam[] = [
      ...seed,
      toolResultMsg('t1', 'alte Evidenz A'),
      toolResultMsg('t2', 'letzte Evidenz B'),
    ];
    // empty allowedIds (e.g. a language_consistency failure that cited nothing)
    const out = trimForRetry(seed, current, new Set<string>(), '', '[VERIFY FEEDBACK] auf Deutsch');
    const blob = JSON.stringify(out);

    expect(blob).toContain('letzte Evidenz B'); // most recent batch kept
    expect(blob).not.toContain('alte Evidenz A'); // older batch dropped
  });
});

describe('runOuterLoop — retry re-grounds on trimmed context (G)', () => {
  it('a citation_coverage failure retries on the trimmed context and passes', async () => {
    mockCallClaude
      // call 1: retrieve R-AIACT-005 → enters allowedIds
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'tool_use',
          toolUse: [{ id: 't1', name: 'search_kb', input: { query: 'R-AIACT-005' } }],
        }),
      )
      // call 2: uncited Art. → citation_coverage fails
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'Art. 5 enthält die Verbote für KI-Systeme im Finanzsektor der EU.',
        }),
      )
      // call 3 (retry): cites the retrieved ID → passes
      .mockResolvedValueOnce(
        makeMessage({
          stopReason: 'end_turn',
          text: 'Art. 5 [R-AIACT-005] enthält die Verbote für KI-Systeme in der EU.',
        }),
      );

    const spec = getModeSpec('CONVERSATIONAL', 'de');
    const result = await runOuterLoop(spec, makeState(), MODEL_IDS.sonnet, 'de');

    expect(result.verify.ok).toBe(true);
    // allowedIds (trust anchor) preserved across the trim.
    expect(result.state.allowedIds.has('R-AIACT-005')).toBe(true);

    // The retry call ran on the trimmed context: no tool_result blocks, and the
    // evidence (R-AIACT-005) was folded in as text.
    const retryMessages = mockCallClaude.mock.calls[2][0].messages as Anthropic.MessageParam[];
    const retryHasToolResults = retryMessages.some(
      (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(retryHasToolResults).toBe(false);
    expect(JSON.stringify(retryMessages)).toContain('R-AIACT-005');
  });
});
