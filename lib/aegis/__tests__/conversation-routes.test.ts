import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// These tests cover the ANONYMOUS-SESSION ownership semantics (multi mode,
// no auth cookie sent). In the default local mode every request resolves to
// the implicit local user instead, which is covered by the shipped behaviour
// of the conversation adoption path.
const savedMode = process.env.AUTH_MODE;
beforeEach(() => {
  process.env.AUTH_MODE = 'multi';
});

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { fakeDb } from './helpers/fake-db';
import { createSession, SESSION_COOKIE } from '@/lib/session';
import { appendMessage, createConversation } from '../memory';
import {
  GET as getTranscriptRoute,
  DELETE as deleteConversationRoute,
} from '@/app/api/aegis/conversations/[id]/route';
import {
  GET as listRoute,
  DELETE as wipeRoute,
} from '@/app/api/aegis/conversations/route';

afterEach(() => {
  fakeDb.reset();
  if (savedMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = savedMode;
});

function request(sessionValue?: string): NextRequest {
  return new NextRequest('http://localhost/api/aegis/conversations/test', {
    headers: sessionValue ? { cookie: `${SESSION_COOKIE}=${sessionValue}` } : {},
  });
}

async function seedConversation(): Promise<{ id: string; cookie: string; sessionId: string }> {
  const session = createSession();
  const id = (await createConversation({
    sessionId: session.id,
    mode: 'CONVERSATIONAL',
    language: 'de',
    firstUserMessage: 'Was ist DORA?',
  }))!;
  await appendMessage(id, { role: 'user', content: 'Was ist DORA?' });
  await appendMessage(id, { role: 'assistant', content: 'DORA ist …' });
  return { id, cookie: session.value, sessionId: session.id };
}

describe('GET /api/aegis/conversations/[id]', () => {
  it('404 without a cookie', async () => {
    const { id } = await seedConversation();
    const res = await getTranscriptRoute(request(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });

  it('404 for a foreign session', async () => {
    const { id } = await seedConversation();
    const foreign = createSession();
    const res = await getTranscriptRoute(request(foreign.value), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
  });

  it('200 with the transcript for the owner', async () => {
    const { id, cookie } = await seedConversation();
    const res = await getTranscriptRoute(request(cookie), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toBe('DORA ist …');
  });
});

describe('DELETE /api/aegis/conversations/[id]', () => {
  it('404 for foreign session, 200 + erasure note for the owner', async () => {
    const { id, cookie } = await seedConversation();
    const foreign = createSession();

    const forbidden = await deleteConversationRoute(request(foreign.value), {
      params: Promise.resolve({ id }),
    });
    expect(forbidden.status).toBe(404);
    expect(fakeDb.conversationRows).toHaveLength(1);

    const ok = await deleteConversationRoute(request(cookie), {
      params: Promise.resolve({ id }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { message: string };
    expect(body.message).toContain('Nutzungsstatistiken');
    expect(fakeDb.conversationRows).toHaveLength(0);
    expect(fakeDb.messageRows).toHaveLength(0);
  });
});

describe('GET /api/aegis/conversations (list)', () => {
  it('lists only the requesting session, empty without cookie', async () => {
    const { cookie } = await seedConversation();
    await seedConversation(); // a second, foreign conversation

    const anonymous = await listRoute(request());
    expect(((await anonymous.json()) as { conversations: unknown[] }).conversations).toEqual([]);

    const owned = await listRoute(request(cookie));
    const body = (await owned.json()) as { conversations: Array<{ title: string | null }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].title).toBe('Was ist DORA?');
  });
});

describe('DELETE /api/aegis/conversations (wipe session)', () => {
  it('deletes everything owned by the session', async () => {
    const { cookie, sessionId } = await seedConversation();
    await createConversation({
      sessionId,
      mode: 'ASSESS',
      language: 'de',
      firstUserMessage: 'Zweite Unterhaltung',
    });

    const res = await wipeRoute(request(cookie));
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(2);
    expect(fakeDb.conversationRows).toHaveLength(0);
  });
});
