import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The route reads its stream deadline at module load. Locally the default is now
// effectively unbounded (24h), so pin an explicit small deadline BEFORE the route
// is imported (vi.hoisted runs before hoisted imports) to keep this test fast and
// deterministic regardless of hosted/local defaults.
vi.hoisted(() => {
  process.env.AEGIS_STREAM_DEADLINE_MS = '290000';
});

// Limiter allows; session fixed.
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: async () => ({ ok: true, remaining: 29, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));
vi.mock('@/lib/session', () => ({ readSessionId: () => 'sess-1' }));
// Auth gate: treat the caller as a signed-in, approved user.
vi.mock('@/lib/aegis/soul-store', () => ({ buildUserSoulBlock: async () => null }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1', email: 'u@test', status: 'APPROVED', role: 'USER' }),
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));

// Mock ONLY runAegisStreaming (keep the real UsageRecorder so we can spy on it).
// The generator hangs forever, so the stream deadline must win the race.
vi.mock('@/lib/aegis', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/aegis')>();
  return {
    ...actual,
    runAegisStreaming: () => ({
      next: () => new Promise<never>(() => {}), // never resolves
      return: async () => ({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    }),
  };
});

import { POST } from '../route';
import { UsageRecorder } from '@/lib/aegis';

function sseReq(): NextRequest {
  return new NextRequest('http://localhost/api/aegis', {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'CONVERSATIONAL', message: 'Was ist DORA?' }),
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/aegis (SSE) — stream deadline', () => {
  it('emits a terminal timeout error, sets exitReason, and closes the stream', async () => {
    const setMeta = vi.spyOn(UsageRecorder.prototype, 'setMeta');

    const res = await POST(sseReq());
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const collected = (async () => {
      let out = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break; // stream closed → guaranteed terminal event was sent
        out += decoder.decode(value);
      }
      return out;
    })();

    // Trip the deadline; advance past any configured default (env-overridable,
    // default 290s). advanceTimersByTimeAsync flushes the racing microtasks.
    await vi.advanceTimersByTimeAsync(310_000);

    const text = await collected;
    expect(text).toContain('event: error');
    expect(text).toContain('"code":"timeout"');
    expect(setMeta).toHaveBeenCalledWith(expect.objectContaining({ exitReason: 'timeout' }));
  });
});
