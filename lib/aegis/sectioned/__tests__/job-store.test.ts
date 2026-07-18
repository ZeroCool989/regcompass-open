import { describe, expect, it } from 'vitest';
import { makeStubDb, PLAN } from './stub-db';
import {
  consumeResume,
  createJob,
  firstUserMessage,
  loadJobForOwner,
  persistSectionResult,
  resetStaleWriting,
  transitionJob,
  transitionSection,
} from '../job-store';
import { InvalidTransitionError } from '../statechart';

async function seededJob(stub: ReturnType<typeof makeStubDb>) {
  stub.conversations.push({
    id: 'conv-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    mode: 'ASSESS',
    language: 'de',
  });
  return createJob('conv-1', PLAN, stub);
}

describe('createJob', () => {
  it('creates the job in planning with one pending row per plan section', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    expect(job.status).toBe('planning');
    expect(job.cursor).toBe(0);
    expect(stub.sections).toHaveLength(2);
    expect(stub.sections.every((s) => s.status === 'pending')).toBe(true);
    expect(stub.sections.map((s) => s.title)).toEqual(['Einleitung', 'Kontrollkatalog']);
  });
});

describe('ownership-scoped load (F2)', () => {
  it('loads for the owning session and the owning user', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    expect(await loadJobForOwner(job.id, { sessionId: 'sess-1', userId: null }, stub)).not.toBeNull();
    const byUser = await loadJobForOwner(job.id, { sessionId: null, userId: 'user-1' }, stub);
    expect(byUser?.conversation).toEqual({ mode: 'ASSESS', language: 'de' });
  });

  it('yields null for foreign owners, unknown ids and anonymous callers', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    expect(await loadJobForOwner(job.id, { sessionId: 'other', userId: 'intruder' }, stub)).toBeNull();
    expect(await loadJobForOwner('nope', { sessionId: 'sess-1', userId: null }, stub)).toBeNull();
    expect(await loadJobForOwner(job.id, { sessionId: null, userId: null }, stub)).toBeNull();
  });

  it('treats an expired job as gone', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    job.expiresAt = new Date(Date.now() - 1000);
    expect(await loadJobForOwner(job.id, { sessionId: 'sess-1', userId: null }, stub)).toBeNull();
  });
});

describe('guarded transitions', () => {
  it('performs a valid transition exactly once', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await transitionJob(job.id, 'planning', 'running', stub);
    expect(stub.jobs[0].status).toBe('running');
  });

  it('throws when the stored status is stale (lost race)', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await transitionJob(job.id, 'planning', 'running', stub);
    await expect(transitionJob(job.id, 'planning', 'running', stub)).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it('rejects statically-invalid pairs before touching the store', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await expect(transitionJob(job.id, 'planning', 'done', stub)).rejects.toThrow(
      InvalidTransitionError,
    );
    expect(stub.jobs[0].status).toBe('planning');
  });
});

describe('persistSectionResult (P3: all-or-nothing)', () => {
  it('writes content + metadata and advances the cursor in one step', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await transitionJob(job.id, 'planning', 'running', stub);
    await transitionSection(job.id, 0, 'pending', 'writing', stub);
    await persistSectionResult(
      job.id,
      0,
      'writing',
      {
        status: 'done',
        contentMd: '## Einleitung\nText [R-DORA-001]',
        digestJson: { claims: [] },
        citationsJson: ['[R-DORA-001]'],
        verifyJson: { ok: true },
        firstPassOk: true,
      },
      stub,
    );
    expect(stub.sections[0].status).toBe('done');
    expect(stub.sections[0].contentMd).toContain('Einleitung');
    expect(stub.jobs[0].cursor).toBe(1);
  });

  it('refuses to persist over a stale section status', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await expect(
      persistSectionResult(
        job.id,
        0,
        'writing', // actual stored status is still 'pending'
        {
          status: 'done',
          contentMd: 'x',
          digestJson: null,
          citationsJson: [],
          verifyJson: null,
          firstPassOk: false,
        },
        stub,
      ),
    ).rejects.toThrow(InvalidTransitionError);
    expect(stub.jobs[0].cursor).toBe(0);
    expect(stub.sections[0].contentMd).toBeNull();
  });
});

describe('resetStaleWriting (non-duplicating retries)', () => {
  it('returns writing/revising sections to pending', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await transitionSection(job.id, 0, 'pending', 'writing', stub);
    const count = await resetStaleWriting(job.id, stub);
    expect(count).toBe(1);
    expect(stub.sections[0].status).toBe('pending');
  });
});

describe('consumeResume (F4)', () => {
  it('increments atomically until the cap, then fails the job closed', async () => {
    const stub = makeStubDb();
    const job = await seededJob(stub);
    await transitionJob(job.id, 'planning', 'running', stub);
    await transitionJob(job.id, 'running', 'paused', stub);
    for (let i = 1; i <= 12; i++) {
      const r = await consumeResume(job.id, 'paused', stub);
      expect(r.ok).toBe(true);
    }
    const exhausted = await consumeResume(job.id, 'paused', stub);
    expect(exhausted).toEqual({ ok: false, reason: 'cap_exceeded' });
    expect(stub.jobs[0].status).toBe('failed');
  });
});

describe('firstUserMessage', () => {
  it('returns the earliest user turn', async () => {
    const stub = makeStubDb();
    await seededJob(stub);
    stub.messages.push(
      { conversationId: 'conv-1', role: 'assistant', seq: 2, content: 'a' },
      { conversationId: 'conv-1', role: 'user', seq: 1, content: 'Erstelle den Report.' },
    );
    expect(await firstUserMessage('conv-1', stub)).toBe('Erstelle den Report.');
  });
});
