import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async () => {
  const { fakeDb } = await import('./helpers/fake-db');
  return { db: fakeDb };
});

import { fakeDb } from './helpers/fake-db';
import {
  appendMessage,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  getConversation,
  getSeedRows,
  getTranscript,
  sweepExpiredConversations,
} from '../memory';
import {
  buildSeed,
  estimateTokens,
  extractCompletePairs,
  type SeedSourceMessage,
} from '../memory-seed';

const SESSION = 'session-a';
const OTHER = 'session-b';

afterEach(() => {
  fakeDb.reset();
  vi.restoreAllMocks();
});

async function makeConversation(sessionId = SESSION): Promise<string> {
  const id = await createConversation({
    sessionId,
    mode: 'CONVERSATIONAL',
    language: 'de',
    firstUserMessage: 'Was ist DORA?',
  });
  expect(id).not.toBeNull();
  return id!;
}

// ───────────────────────── Ownership ─────────────────────────

describe('conversation ownership', () => {
  it('is invisible without a session', async () => {
    const id = await makeConversation();
    expect(await getConversation(id, null)).toBeNull();
    expect(await getTranscript(id, null)).toBeNull();
  });

  it('is invisible to a foreign session', async () => {
    const id = await makeConversation();
    expect(await getConversation(id, OTHER)).toBeNull();
    expect(await deleteConversation(id, OTHER)).toBe(false);
  });

  it('is visible to the owner', async () => {
    const id = await makeConversation();
    expect(await getConversation(id, SESSION)).not.toBeNull();
    expect(await deleteConversation(id, SESSION)).toBe(true);
  });
});

// ───────────────────────── Seq assignment (amendment 4) ─────────────────────────

describe('appendMessage seq', () => {
  it('assigns dense sequential seqs', async () => {
    const id = await makeConversation();
    expect(await appendMessage(id, { role: 'user', content: 'eins' })).toBe(0);
    expect(await appendMessage(id, { role: 'assistant', content: 'zwei' })).toBe(1);
    expect(await appendMessage(id, { role: 'user', content: 'drei' })).toBe(2);
  });

  it('survives a concurrent insert race: no crash, no dropped turn', async () => {
    const id = await makeConversation();
    // The fake's $transaction has no isolation, so both writers read max(seq)
    // before either inserts — the second create hits the @@unique (P2002) and
    // must succeed via the single retry.
    const [a, b] = await Promise.all([
      appendMessage(id, { role: 'user', content: 'parallel-a' }),
      appendMessage(id, { role: 'user', content: 'parallel-b' }),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(new Set([a, b])).toEqual(new Set([0, 1]));
    expect(fakeDb.messageRows).toHaveLength(2);
  });

  it('fails open (null) and logs when the DB write keeps failing', async () => {
    const id = await makeConversation();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakeDb.aegisMessage, 'create').mockRejectedValue(new Error('db down'));
    const seq = await appendMessage(id, { role: 'user', content: 'verloren' });
    expect(seq).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('aegis_memory_write_failed');
  });
});

// ───────────────────────── Erasure ─────────────────────────

describe('erasure', () => {
  it('cascade-deletes messages; content-free usage rows survive', async () => {
    const id = await makeConversation();
    await appendMessage(id, { role: 'user', content: 'frage' });
    await appendMessage(id, { role: 'assistant', content: 'antwort' });
    await fakeDb.aegisUsageLog.create({
      data: { conversationId: id, costCents: 1.5 },
    });

    expect(await deleteConversation(id, SESSION)).toBe(true);
    expect(fakeDb.conversationRows).toHaveLength(0);
    expect(fakeDb.messageRows).toHaveLength(0);
    // Locked decision: usage rows are retained, conversationId intact.
    expect(fakeDb.usageRows).toHaveLength(1);
    expect(fakeDb.usageRows[0].conversationId).toBe(id);
  });

  it('wipes all conversations of one session, not others', async () => {
    await makeConversation(SESSION);
    await makeConversation(SESSION);
    const foreign = await makeConversation(OTHER);
    expect(await deleteAllConversations(SESSION)).toBe(2);
    expect(fakeDb.conversationRows.map((r) => r.id)).toEqual([foreign]);
  });
});

// ───────────────────────── Retention (amendments 1+2) ─────────────────────────

describe('retention sweep', () => {
  it('deletes expired conversations and keeps in-window ones', async () => {
    const expired = await makeConversation();
    await appendMessage(expired, { role: 'user', content: 'alt' });
    const kept = await makeConversation();
    // Force expiry on the first conversation.
    fakeDb.conversationRows.find((r) => r.id === expired)!.expiresAt = new Date(
      Date.now() - 1000,
    );

    const deleted = await sweepExpiredConversations();
    expect(deleted).toBe(1);
    expect(fakeDb.conversationRows.map((r) => r.id)).toEqual([kept]);
    // Cascade removed the expired conversation's messages too.
    expect(fakeDb.messageRows.filter((m) => m.conversationId === expired)).toHaveLength(0);
  });

  it('expired conversations are already invisible to reads', async () => {
    const id = await makeConversation();
    fakeDb.conversationRows.find((r) => r.id === id)!.expiresAt = new Date(
      Date.now() - 1000,
    );
    expect(await getConversation(id, SESSION)).toBeNull();
  });
});

// ───────────────────────── Seed builder (amendments 3+5) ─────────────────────────

function msg(
  seq: number,
  role: 'user' | 'assistant',
  content: string,
  status: 'complete' | 'failed' = 'complete',
): SeedSourceMessage {
  return { seq, role, content, status };
}

describe('seed builder', () => {
  it('excludes failed turns and their user message', () => {
    const seed = buildSeed(
      [
        msg(0, 'user', 'erste frage'),
        msg(1, 'assistant', 'erste antwort'),
        msg(2, 'user', 'fehlgeschlagene frage'),
        msg(3, 'assistant', '', 'failed'),
        msg(4, 'user', 'zweite frage'),
        msg(5, 'assistant', 'zweite antwort'),
      ],
      'de',
      24_000,
    );
    expect(seed.map((m) => m.content)).toEqual([
      'erste frage',
      'erste antwort',
      'zweite frage',
      'zweite antwort',
    ]);
  });

  it('excludes an orphaned user message (no assistant row at all)', () => {
    const seed = buildSeed(
      [
        msg(0, 'user', 'frage'),
        msg(1, 'assistant', 'antwort'),
        msg(2, 'user', 'verwaiste frage'), // run died before any assistant row
      ],
      'de',
      24_000,
    );
    expect(seed.map((m) => m.content)).toEqual(['frage', 'antwort']);
  });

  it('always alternates user/assistant starting with user', () => {
    const messy: SeedSourceMessage[] = [
      msg(0, 'user', 'a'),
      msg(1, 'assistant', 'b'),
      msg(2, 'assistant', 'defensiv-verwaist'), // no pending user — skipped
      msg(3, 'user', 'c'),
      msg(4, 'user', 'd'), // supersedes c
      msg(5, 'assistant', 'e'),
    ];
    const seed = buildSeed(messy, 'de', 24_000);
    expect(seed.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(seed.map((m) => m.content)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('keeps the newest pairs under the token budget (whole pairs only)', () => {
    const big = 'x'.repeat(3500); // ≈1000 tokens (de)
    const seed = buildSeed(
      [
        msg(0, 'user', big),
        msg(1, 'assistant', big),
        msg(2, 'user', big),
        msg(3, 'assistant', big),
        msg(4, 'user', 'kleine frage'),
        msg(5, 'assistant', 'kleine antwort'),
      ],
      'de',
      2_100, // fits the small pair + one big pair, not both big pairs
    );
    // Newest-first selection: small pair + the second big pair.
    expect(seed).toHaveLength(4);
    expect(seed[0].content).toBe(big);
    expect(seed[2].content).toBe('kleine frage');
  });

  it('uses chars/3.5 for German and chars/4 for English', () => {
    expect(estimateTokens('x'.repeat(700), 'de')).toBe(200);
    expect(estimateTokens('x'.repeat(700), 'en')).toBe(175);
  });

  it('extractCompletePairs sorts by seq regardless of input order', () => {
    const pairs = extractCompletePairs([
      msg(1, 'assistant', 'antwort'),
      msg(0, 'user', 'frage'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].user.content).toBe('frage');
  });
});

// ───────────────────────── Seed rows projection ─────────────────────────

describe('getSeedRows', () => {
  it('returns lean ordered rows', async () => {
    const id = await makeConversation();
    await appendMessage(id, { role: 'user', content: 'frage', citedIds: ['R-X-1'] });
    await appendMessage(id, {
      role: 'assistant',
      content: 'antwort',
      toolCalls: [{ name: 'search_kb', input: {}, result: 'r', isError: false }],
    });
    const rows = await getSeedRows(id);
    expect(rows).toEqual([
      { seq: 0, role: 'user', content: 'frage', status: 'complete' },
      { seq: 1, role: 'assistant', content: 'antwort', status: 'complete' },
    ]);
  });
});
