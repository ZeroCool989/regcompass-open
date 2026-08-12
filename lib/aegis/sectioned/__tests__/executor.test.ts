import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModeSpec } from '../../modes';
import type { VerifyResult } from '../../types';
import { CostAccumulator } from '../../context/cost';
import { executeJobSections, type ExecutorContext, type ExecutorDeps } from '../executor';
import { createJob, transitionJob, type JobWithSections } from '../job-store';
import type { SectionedStreamEvent } from '../events';
import { EMPTY_SECTION_DIGEST } from '../section-digest';
import { makeStubDb, PLAN } from './stub-db';

const BASE_SPEC: ModeSpec = {
  systemBlocks: [{ text: 'identity', cached: true }],
  defaultTools: ['search_kb', 'get_requirements'],
  maxTokens: 16384,
  maxIterations: 15,
};

const PASS: VerifyResult = {
  ok: true,
  checks: {
    citation_coverage: 'pass',
    no_hallucinated_regulations: 'pass',
    unsupported_regulatory_claim: 'pass',
    language_consistency: 'pass',
    non_empty_response: 'pass',
    no_false_ignorance: 'pass',
  },
};
const FAIL: VerifyResult = {
  ok: false,
  failed: 'citation_coverage',
  reason: 'Uncited claim.',
  feedback: 'Cite it.',
};

// Executor now consumes SectionVerifyOutcome (PR 2 / F8 allowlist).
const PASS_OUT = { verify: PASS, externalRefs: [] as string[] };
const FAIL_OUT = { verify: FAIL, externalRefs: [] as string[] };

/** Inner-loop stub: yields two tokens then returns the section text. */
function stubInnerLoop(texts: string[]): ExecutorDeps['innerLoop'] {
  let call = 0;
   
  return async function* stub() {
    const text = texts[Math.min(call, texts.length - 1)];
    call++;
    yield { type: 'token' as const, text: text.slice(0, 4) };
    yield { type: 'token' as const, text: text.slice(4) };
    return text;
  } as unknown as ExecutorDeps['innerLoop'];
}

async function runToEnd(
  gen: AsyncGenerator<SectionedStreamEvent, unknown, void>,
): Promise<{ events: SectionedStreamEvent[]; outcome: unknown }> {
  const events: SectionedStreamEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, outcome: r.value };
}

async function seededRunningJob(stub: ReturnType<typeof makeStubDb>): Promise<JobWithSections> {
  stub.conversations.push({
    id: 'conv-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    mode: 'ASSESS',
    language: 'de',
  });
  const job = await createJob('conv-1', PLAN, 'anthropic-api', stub);
  await transitionJob(job.id, 'planning', 'running', stub);
  return {
    job: { ...job, status: 'running' },
    sections: [],
    conversation: { mode: 'ASSESS', language: 'de' },
  };
}

function ctx(deadlineAt: number): ExecutorContext {
  return {
    baseSpec: BASE_SPEC,
    language: 'de',
    userMessage: 'Erstelle den Report.',
    deadlineAt,
    cost: new CostAccumulator(),
    toolContext: { sessionId: 'sess-1', userId: 'user-1', conversationId: 'conv-1', onUsage: () => {} },
  };
}

function happyDeps(stub: ReturnType<typeof makeStubDb>, texts: string[]): ExecutorDeps {
  return {
    client: stub,
    innerLoop: stubInnerLoop(texts),
    verifyFn: () => PASS_OUT,
    digestFn: async () => EMPTY_SECTION_DIGEST,
    repair: vi.fn(),
  };
}

describe('executeJobSections — happy path', () => {
  it('runs sections sequentially, persists each, finishes the job', async () => {
    const stub = makeStubDb();
    const loaded = await seededRunningJob(stub);
    const { events, outcome } = await runToEnd(
      executeJobSections(loaded, ctx(Date.now() + 600_000), happyDeps(stub, ['Text A.', 'Text B.'])),
    );

    expect(events.map((e) => e.type)).toEqual([
      'section_start',
      'section_token',
      'section_token',
      'section_done',
      'section_start',
      'section_token',
      'section_token',
      'section_done',
      'job_done',
    ]);
    expect(outcome).toEqual({ status: 'done' });
    expect(stub.jobs[0].status).toBe('done');
    expect(stub.jobs[0].cursor).toBe(2);
    expect(stub.sections.map((s) => s.status)).toEqual(['done', 'done']);
    expect(stub.sections[0].firstPassOk).toBe(true);
  });
});

describe('executeJobSections — provider pinning (real done-path digest)', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('pins the per-section digest to the request provider even when AEGIS_BRAIN=gemini', async () => {
    process.env.AEGIS_BRAIN = 'gemini'; // hostile: names a different brain
    const stub = makeStubDb();
    const loaded = await seededRunningJob(stub);
    const digestSpy = vi.fn(
      (_text: string, _deps?: { provider?: 'anthropic' | 'gemini' }) => Promise.resolve(EMPTY_SECTION_DIGEST),
    );
    const deps: ExecutorDeps = { ...happyDeps(stub, ['Text A.']), digestFn: digestSpy as never };
    const c = ctx(Date.now() + 600_000);
    // The request's frozen selection is Anthropic (index.ts sets toolContext.provider).
    c.toolContext!.provider = 'anthropic';

    await runToEnd(executeJobSections(loaded, c, deps));

    // The done path reached the digest, and it was handed the frozen provider —
    // NOT left to fall through to AEGIS_BRAIN=gemini.
    expect(digestSpy).toHaveBeenCalled();
    for (const call of digestSpy.mock.calls) {
      expect(call[1]?.provider).toBe('anthropic');
    }
  });
});

describe('P3 time gate', () => {
  it('pauses cleanly BEFORE a section when under the resume floor', async () => {
    const stub = makeStubDb();
    const loaded = await seededRunningJob(stub);
    // 600s of budget for section 0, then the clock jumps to 30s left.
    let calls = 0;
    const now = (): number => {
      calls++;
      return calls <= 1 ? 1_000_000 : 1_000_000 + 570_000;
    };
    const deps = { ...happyDeps(stub, ['Text A.']), now };
    const { events, outcome } = await runToEnd(
      executeJobSections(loaded, { ...ctx(1_000_000 + 600_000) }, deps),
    );

    const types = events.map((e) => e.type);
    expect(types.at(-1)).toBe('job_paused');
    expect(types).not.toContain('job_done');
    expect(outcome).toEqual({ status: 'paused', cursor: 1 });
    expect(stub.jobs[0].status).toBe('paused');
    // Section 0 fully persisted; section 1 untouched — nothing half-finished.
    expect(stub.sections.map((s) => s.status)).toEqual(['done', 'pending']);
  });
});

describe('F9 repair → degraded', () => {
  it('runs ≤2 tool-free repairs then degrades the section and CONTINUES', async () => {
    const stub = makeStubDb();
    const loaded = await seededRunningJob(stub);
    const repair = vi.fn().mockResolvedValue('Immer noch ohne Zitat.');
    const verifyFn = vi
      .fn()
      .mockReturnValueOnce(FAIL_OUT) // section 0: initial verify
      .mockReturnValueOnce(FAIL_OUT) // repair 1 re-verify
      .mockReturnValueOnce(FAIL_OUT) // repair 2 re-verify → degraded
      .mockReturnValue(PASS_OUT); // section 1 passes
    const deps: ExecutorDeps = {
      client: stub,
      innerLoop: stubInnerLoop(['Ohne Zitat.', 'Text B.']),
      verifyFn,
      digestFn: async () => EMPTY_SECTION_DIGEST,
      repair,
    };
    const { events, outcome } = await runToEnd(
      executeJobSections(loaded, ctx(Date.now() + 600_000), deps),
    );

    expect(repair).toHaveBeenCalledTimes(2);
    const dones = events.filter((e): e is Extract<SectionedStreamEvent, { type: 'section_done' }> => e.type === 'section_done');
    expect(dones[0]).toMatchObject({ status: 'degraded', firstPassOk: false });
    expect(dones[1]).toMatchObject({ status: 'done', firstPassOk: true });
    expect(outcome).toEqual({ status: 'done' }); // job continues despite degrade
    expect(stub.sections[0].status).toBe('degraded');
  });
});

describe('upstream failure', () => {
  it('fails the job closed but keeps finished sections', async () => {
    const stub = makeStubDb();
    const loaded = await seededRunningJob(stub);
    let call = 0;
    const failingLoop = async function* () {
      call++;
      if (call === 1) {
        yield { type: 'token' as const, text: 'Text A.' };
        return 'Text A.';
      }
      throw Object.assign(new Error('529 overloaded'), { code: 'upstream_error' });
    } as unknown as ExecutorDeps['innerLoop'];
    const deps: ExecutorDeps = {
      client: stub,
      innerLoop: failingLoop,
      verifyFn: () => PASS_OUT,
      digestFn: async () => EMPTY_SECTION_DIGEST,
    };
    const { events, outcome } = await runToEnd(
      executeJobSections(loaded, ctx(Date.now() + 600_000), deps),
    );

    expect(events.at(-1)?.type).toBe('job_failed');
    expect(outcome).toMatchObject({ status: 'failed', code: 'upstream_error' });
    expect(stub.jobs[0].status).toBe('failed');
    expect(stub.sections[0].status).toBe('done'); // partial results persist
  });
});

describe('resume seeding', () => {
  it('starts from the cursor and reuses digests of finished sections', async () => {
    const stub = makeStubDb();
    await seededRunningJob(stub);
    // Simulate section 0 already finished in a previous invocation.
    stub.sections[0].status = 'done';
    stub.sections[0].contentMd = 'Alt.';
    stub.sections[0].digestJson = { ...EMPTY_SECTION_DIGEST, claims: ['Alte Kernaussage'] };
    stub.jobs[0].cursor = 1;
    const resumed: JobWithSections = {
      job: { ...stub.jobs[0] },
      sections: [...stub.sections],
      conversation: { mode: 'ASSESS', language: 'de' },
    };

    const innerLoop = vi.fn(stubInnerLoop(['Text B.']));
    const deps: ExecutorDeps = {
      client: stub,
      innerLoop: innerLoop as unknown as ExecutorDeps['innerLoop'],
      verifyFn: () => PASS_OUT,
      digestFn: async () => EMPTY_SECTION_DIGEST,
    };
    const { events } = await runToEnd(
      executeJobSections(resumed, ctx(Date.now() + 600_000), deps),
    );

    // Only section 1 runs…
    const starts = events.filter((e) => e.type === 'section_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ index: 1 });
    // …and its spec carries the finished section's digest in the context block.
    const specArg = innerLoop.mock.calls[0][0] as ModeSpec;
    const contextBlock = specArg.systemBlocks.at(-1)?.text ?? '';
    expect(contextBlock).toContain('Alte Kernaussage');
    expect(stub.jobs[0].status).toBe('done');
  });
});
