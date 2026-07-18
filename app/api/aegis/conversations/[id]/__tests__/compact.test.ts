import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: async () => ({ ok: true, remaining: 19, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));

const approved = { id: 'u1', email: 'a@test', username: 'a', status: 'APPROVED', role: 'USER' };
const { getUserFromRequest } = vi.hoisted(() => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest,
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));
vi.mock('@/lib/session', () => ({ readSessionId: () => 'sess-1' }));

const { getTranscriptForUser, storeDigest, generateDigest } = vi.hoisted(() => ({
  getTranscriptForUser: vi.fn(),
  storeDigest: vi.fn(),
  generateDigest: vi.fn(),
}));
vi.mock('@/lib/aegis/memory', () => ({
  claimSessionConversations: vi.fn(async () => 0),
  getTranscript: vi.fn(),
  getTranscriptForUser,
  storeDigest,
}));
vi.mock('@/lib/aegis/digest', async (orig) => {
  const actual = await orig<typeof import('@/lib/aegis/digest')>();
  return { ...actual, generateDigest }; // keep real DigestInputTooLargeError etc.
});

import { POST } from '../compact/route';
import { DigestInputTooLargeError } from '@/lib/aegis/digest';

const params = (id = 'conv-1') => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest('http://localhost/api/aegis/conversations/conv-1/compact', { method: 'POST' });

function transcript(n: number) {
  const messages = Array.from({ length: n }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    status: 'complete',
  }));
  return { conversation: { id: 'conv-1' }, messages };
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/aegis/conversations/[id]/compact', () => {
  it('401 when not an approved user', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await POST(req(), params());
    expect(res.status).toBe(401);
  });

  it('400 when the conversation is too short to compact', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    getTranscriptForUser.mockResolvedValue(transcript(2));
    const res = await POST(req(), params());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('too_short');
  });

  it('generates + stores a digest and returns 200', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    getTranscriptForUser.mockResolvedValue(transcript(6));
    generateDigest.mockResolvedValue({
      decisions: ['d'], openTasks: [], conclusions: ['c [R-X-1]'], preferencesObserved: [],
    });
    storeDigest.mockResolvedValue(true);

    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.compacted).toBe(true);
    expect(body.throughSeq).toBe(5);
    expect(generateDigest).toHaveBeenCalledOnce();
    expect(storeDigest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-1', userId: 'u1', throughSeq: 5 }),
    );
  });

  it('404 when the conversation is not found', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    getTranscriptForUser.mockResolvedValue(null);
    const res = await POST(req(), params());
    expect(res.status).toBe(404);
  });

  it('502 when digest generation fails', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    getTranscriptForUser.mockResolvedValue(transcript(6));
    generateDigest.mockRejectedValue(new Error('upstream'));
    const res = await POST(req(), params());
    expect(res.status).toBe(502);
  });

  it('413 when the transcript is too large to compact', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    getTranscriptForUser.mockResolvedValue(transcript(6));
    generateDigest.mockRejectedValue(new DigestInputTooLargeError(999_999));
    const res = await POST(req(), params());
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('too_large');
  });

  it('throughSeq is monotonic and each compaction is rebuilt from the FULL transcript (no digest-of-digest)', async () => {
    getUserFromRequest.mockResolvedValue(approved);
    generateDigest.mockResolvedValue({
      decisions: [], openTasks: [], conclusions: [], preferencesObserved: [],
    });
    storeDigest.mockResolvedValue(true);

    // First compaction over 6 turns.
    getTranscriptForUser.mockResolvedValue(transcript(6));
    const first = await POST(req(), params());
    const firstBody = await first.json();
    expect(firstBody.throughSeq).toBe(5);
    expect(generateDigest.mock.calls[0][0]).toHaveLength(6); // full transcript

    // Conversation grew to 8 turns; recompaction sees ALL 8 (not a prior digest).
    getTranscriptForUser.mockResolvedValue(transcript(8));
    const second = await POST(req(), params());
    const secondBody = await second.json();
    expect(secondBody.throughSeq).toBe(7);
    expect(secondBody.throughSeq).toBeGreaterThan(firstBody.throughSeq); // monotonic
    expect(generateDigest.mock.calls[1][0]).toHaveLength(8); // full transcript again
  });
});
