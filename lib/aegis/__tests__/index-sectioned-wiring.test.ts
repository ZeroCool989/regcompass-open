import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Station-2 wiring tests. The load-bearing assertion is F5: with the sectioned
 * flag OFF (default) — and with the flag ON but triage deciding SINGLE_PASS —
 * the streamed event sequence of the single-pass pipeline is IDENTICAL. The
 * sectioned path only ever engages when triage says SECTIONED, and a plan
 * failure falls back silently without touching the stream.
 */

vi.mock('../loop', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    runOuterLoop: vi.fn(),
    runOuterLoopStreaming: vi.fn(),
  };
});
vi.mock('../memory', () => ({
  appendMessage: vi.fn().mockResolvedValue(1),
  createConversation: vi.fn().mockResolvedValue('conv-1'),
  getConversation: vi.fn().mockResolvedValue(null),
  getConversationForUser: vi.fn().mockResolvedValue(null),
  getDigest: vi.fn().mockResolvedValue(null),
  getSeedRows: vi.fn().mockResolvedValue([]),
}));
vi.mock('../router', () => ({
  getIntentClassifier: vi.fn(() => 'heuristic'),
  estimateComplexity: vi.fn(() => 0.5),
  classifyIntent: vi.fn(),
  routeToModel: vi.fn(() => ({ model: 'claude-sonnet-4-6' })),
  // D8 overlay: identity here — preference logic has its own unit tests.
  applyModelPreference: vi.fn((d: unknown) => d),
}));
vi.mock('../client', () => ({
  callHaiku: vi.fn(),
}));
// Provider selection is exercised by its own tests; here pin a fixed Anthropic
// selection (system key) so these F5 byte-identity assertions don't depend on
// the DB/aegisProvider lookup. This is the pre-BYOK behaviour F5 is defined against.
vi.mock('../runtime-selection', () => {
  const credential = { source: 'system', apiKey: null, modelHint: null } as const;
  const selection = {
    provider: 'anthropic' as const,
    model: { provider: 'anthropic' as const, model: 'claude-sonnet-4-6' },
    credential,
  };
  return {
    resolveProviderAccess: vi.fn(async () => ({ provider: 'anthropic' as const, credential })),
    buildRuntimeSelection: vi.fn(() => selection),
    dispatchModelId: vi.fn(() => 'claude-sonnet-4-6'),
  };
});
vi.mock('../sectioned/run', () => ({
  sectionedEnabled: vi.fn(() => false),
  triageRequest: vi.fn(),
  startSectionedJob: vi.fn(),
}));

import { runAegisStreaming, type AegisStreamEvent } from '../index';
import { runOuterLoopStreaming } from '../loop';
import { classifyIntent } from '../router';
import { buildRuntimeSelection } from '../runtime-selection';
import { sectionedEnabled, startSectionedJob, triageRequest } from '../sectioned/run';
import type { TriageResult } from '../sectioned/triage';

const mockOuter = vi.mocked(runOuterLoopStreaming);
const mockBuildSelection = vi.mocked(buildRuntimeSelection);
const mockEnabled = vi.mocked(sectionedEnabled);
const mockTriage = vi.mocked(triageRequest);
const mockStart = vi.mocked(startSectionedJob);

const SINGLE_PASS_TRIAGE: TriageResult = {
  mode: 'CONVERSATIONAL',
  complexity: 0.7,
  deliverableKind: 'question',
  deliverableStrategy: 'SINGLE_PASS',
  signals: [],
};

import type { LoopState } from '../loop';
import type { ModeSpec } from '../modes';

function stubOuterLoop(): void {
  mockOuter.mockImplementation(async function* (_spec: ModeSpec, state: LoopState) {
    yield { type: 'status' as const, phase: 'tools' as const, iteration: 0 };
    yield { type: 'token' as const, text: 'Antwort.' };
    return {
      text: 'Antwort.',
      state,
      verify: {
        ok: true as const,
        checks: {
          citation_coverage: 'pass',
          no_hallucinated_regulations: 'pass',
          unsupported_regulatory_claim: 'pass',
          language_consistency: 'pass',
          non_empty_response: 'pass',
          no_false_ignorance: 'pass',
        },
      },
    };
  } as never);
}

const REQUEST = { message: 'Was ist DORA?', mode: 'CONVERSATIONAL', language: 'de' };
const OPTIONS = { sessionId: 'sess-1', userId: 'user-1', deadlineAt: Date.now() + 290_000 };

async function collect(): Promise<AegisStreamEvent[]> {
  const events: AegisStreamEvent[] = [];
  for await (const evt of runAegisStreaming(REQUEST, undefined, OPTIONS)) {
    events.push(evt);
  }
  return events;
}

/** Strip run-dependent fields (latency) for sequence comparison. */
function normalized(events: AegisStreamEvent[]): unknown[] {
  return events.map((e) =>
    e.type === 'done' ? { ...e, meta: { ...e.meta, latency: 0 } } : e,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubOuterLoop();
});

describe('F5 — SINGLE_PASS byte-identity', () => {
  it('flag OFF: streams the single-pass events and never consults triage', async () => {
    mockEnabled.mockReturnValue(false);
    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'token', 'done']);
    expect(mockTriage).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('flag ON + triage says SINGLE_PASS: event sequence is identical', async () => {
    mockEnabled.mockReturnValue(false);
    const baseline = normalized(await collect());

    vi.clearAllMocks();
    stubOuterLoop();
    mockEnabled.mockReturnValue(true);
    mockTriage.mockResolvedValue(SINGLE_PASS_TRIAGE);
    const flagged = normalized(await collect());

    expect(flagged).toEqual(baseline);
    expect(mockTriage).toHaveBeenCalledTimes(1);
    expect(mockStart).not.toHaveBeenCalled();
    // F7: the ONE triage call replaces classifyIntent for the turn…
    expect(classifyIntent).not.toHaveBeenCalled();
    // …and its complexity drives the routed model (routing now lives inside the
    // request-scoped selection: buildRuntimeSelection(access, mode, complexity)).
    expect(mockBuildSelection).toHaveBeenCalledWith(expect.anything(), 'CONVERSATIONAL', 0.7);
  });

  it('voice turns skip triage entirely (F7)', async () => {
    mockEnabled.mockReturnValue(true);
    const events: AegisStreamEvent[] = [];
    for await (const evt of runAegisStreaming(
      { ...REQUEST, voice: true },
      undefined,
      OPTIONS,
    )) {
      events.push(evt);
    }
    expect(mockTriage).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('SECTIONED delegation', () => {
  it('streams sectioned events and skips the single-pass loop', async () => {
    mockEnabled.mockReturnValue(true);
    mockTriage.mockResolvedValue({
      ...SINGLE_PASS_TRIAGE,
      deliverableKind: 'report',
      deliverableStrategy: 'SECTIONED',
      signals: ['kind'],
    });
    mockStart.mockImplementation(async function* () {
      yield { type: 'job_created' as const, jobId: 'job-1', sections: [] };
      yield { type: 'job_done' as const, jobId: 'job-1', cursor: 2 };
      return { kind: 'ran' as const, outcome: { status: 'done' as const }, jobId: 'job-1' };
    } as never);

    const events = await collect();
    expect(events.map((e) => e.type)).toEqual(['job_created', 'job_done']);
    expect(mockOuter).not.toHaveBeenCalled();
  });

  it('falls back to single-pass silently when the plan stage fails', async () => {
    mockEnabled.mockReturnValue(true);
    mockTriage.mockResolvedValue({
      ...SINGLE_PASS_TRIAGE,
      deliverableStrategy: 'SECTIONED',
    });
     
    mockStart.mockImplementation(async function* () {
      return { kind: 'fallback_single_pass' as const, reason: 'plan_validation' };
    } as never);

    const events = await collect();
    // The stream is exactly the single-pass sequence — no sectioned event leaked.
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'token', 'done']);
  });

  it('a stateless turn (no conversation) never sections', async () => {
    mockEnabled.mockReturnValue(true);
    const events: AegisStreamEvent[] = [];
    for await (const evt of runAegisStreaming(REQUEST, undefined, {
      ...OPTIONS,
      sessionId: null,
    })) {
      events.push(evt);
    }
    expect(mockTriage).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('done');
  });
});
