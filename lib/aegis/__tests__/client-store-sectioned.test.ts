import { describe, it, expect, afterAll } from 'vitest';

// Window/localStorage polyfill so the client-store module loads in node —
// same pattern as client-store-persistence.test.ts.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  },
};

import {
  applySectionedEvent,
  joinJobSections,
  readStoredActiveJob,
  type ActiveJob,
} from '../client-store';

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const CREATED = {
  type: 'job_created',
  jobId: 'job-1',
  sections: [
    { index: 0, title: 'Eins', grounded: true },
    { index: 1, title: 'Zwei', grounded: false },
  ],
};

function runningJob(): ActiveJob {
  return applySectionedEvent(null, CREATED).job as ActiveJob;
}

describe('applySectionedEvent — reducer (F5 sectioned contract, F6 vitest-only)', () => {
  it('job_created builds the pending outline', () => {
    const { job, effect } = applySectionedEvent(null, CREATED);
    expect(effect).toEqual({ kind: 'none' });
    expect(job).toMatchObject({
      jobId: 'job-1',
      cursor: 0,
      phase: 'running',
      resumeAttempts: 0,
    });
    expect(job?.sections.map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  it('section lifecycle: start → tokens accumulate → done advances the cursor', () => {
    let job = runningJob();
    job = applySectionedEvent(job, { type: 'section_start', index: 0, title: 'Eins' }).job!;
    expect(job.sections[0].status).toBe('writing');
    job = applySectionedEvent(job, { type: 'section_token', index: 0, text: 'Hallo ' }).job!;
    job = applySectionedEvent(job, { type: 'section_token', index: 0, text: 'Welt.' }).job!;
    expect(job.sections[0].text).toBe('Hallo Welt.');
    const done = applySectionedEvent(job, { type: 'section_done', index: 0, status: 'done', firstPassOk: true });
    expect(done.job?.sections[0].status).toBe('done');
    expect(done.job?.cursor).toBe(1);
  });

  it('section_done resets the reconnect budget (progress ⇒ fresh budget)', () => {
    let job = { ...runningJob(), resumeAttempts: 7 };
    job = applySectionedEvent(job, { type: 'section_done', index: 0, status: 'done' }).job!;
    expect(job.resumeAttempts).toBe(0);
  });

  it('job_paused flips to reconnecting, counts the attempt, and asks for a resume', () => {
    const { job, effect } = applySectionedEvent(runningJob(), {
      type: 'job_paused',
      jobId: 'job-1',
      cursor: 1,
    });
    expect(effect).toEqual({ kind: 'resume' });
    expect(job?.phase).toBe('reconnecting');
    expect(job?.resumeAttempts).toBe(1);
  });

  it('job_state (resume snapshot) rebuilds finished sections incl. persisted text', () => {
    const { job } = applySectionedEvent(runningJob(), {
      type: 'job_state',
      jobId: 'job-1',
      cursor: 1,
      sections: [
        { index: 0, title: 'Eins', status: 'done', contentMd: 'Fertiger Text.' },
        { index: 1, title: 'Zwei', status: 'pending' },
      ],
    });
    expect(job?.sections[0]).toMatchObject({ status: 'done', text: 'Fertiger Text.' });
    expect(job?.sections[1].status).toBe('pending');
    expect(job?.cursor).toBe(1);
    expect(job?.phase).toBe('running');
  });

  it('a resume snapshot never resurrects a half-written section as content (stale writing → pending)', () => {
    const { job } = applySectionedEvent(null, {
      type: 'job_state',
      jobId: 'job-1',
      cursor: 0,
      sections: [{ index: 0, title: 'Eins', status: 'writing' }],
    });
    expect(job?.sections[0]).toMatchObject({ status: 'pending', text: '' });
  });

  it('job_done clears the job and reports the degraded count for honest meta', () => {
    let job = runningJob();
    job = applySectionedEvent(job, { type: 'section_done', index: 0, status: 'done' }).job!;
    job = applySectionedEvent(job, { type: 'section_done', index: 1, status: 'degraded' }).job!;
    const { job: cleared, effect } = applySectionedEvent(job, {
      type: 'job_done',
      jobId: 'job-1',
      cursor: 2,
    });
    expect(cleared).toBeNull();
    expect(effect).toEqual({ kind: 'finalize', degradedSections: 1 });
  });

  it('job_failed clears the job and carries the German failure message', () => {
    const { job, effect } = applySectionedEvent(runningJob(), {
      type: 'job_failed',
      jobId: 'job-1',
      code: 'internal_error',
      message: 'Der Report konnte nicht fortgesetzt werden. Bereits fertige Abschnitte sind gespeichert.',
    });
    expect(job).toBeNull();
    expect(effect.kind).toBe('fail');
  });

  it('single-pass events pass through untouched (F5: two disjoint contracts)', () => {
    const job = runningJob();
    const { job: same, effect } = applySectionedEvent(job, { type: 'token', text: 'x' });
    expect(same).toBe(job);
    expect(effect).toEqual({ kind: 'none' });
  });
});

describe('joinJobSections — client-side report view', () => {
  it('joins sections in order under their plan titles, skipping empty ones', () => {
    let job = runningJob();
    job = applySectionedEvent(job, { type: 'section_token', index: 0, text: 'Inhalt A.' }).job!;
    expect(joinJobSections(job)).toBe('## Eins\n\nInhalt A.');
    job = applySectionedEvent(job, { type: 'section_token', index: 1, text: 'Inhalt B.' }).job!;
    expect(joinJobSections(job)).toBe('## Eins\n\nInhalt A.\n\n## Zwei\n\nInhalt B.');
  });
});

describe('active-job persistence (hydration)', () => {
  it('readStoredActiveJob round-trips through the storage key', () => {
    store.set('aegis-active-job-v1', 'job-42');
    expect(readStoredActiveJob()).toBe('job-42');
    store.delete('aegis-active-job-v1');
    expect(readStoredActiveJob()).toBeNull();
  });
});
