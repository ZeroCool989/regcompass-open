import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Stub the limiter's RETURN — assert the route's 429 contract on exhaustion.
// (Window/reset/increment semantics live in the ON CONFLICT SQL and are
// PG-integration scope — see lib/__tests__/rate-limit.test.ts.)
const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check }),
  ipHash: () => 'iphash',
}));
vi.mock('@/lib/session', () => ({ readSessionId: () => 'sess-1' }));
// Auth gate: treat the caller as a signed-in, approved user.
vi.mock('@/lib/aegis/soul-store', () => ({ buildUserSoulBlock: async () => null }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1', email: 'u@test', status: 'APPROVED', role: 'USER' }),
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));

// If the limiter lets the call through, stop before any real model work — the
// over-limit path returns BEFORE these are touched; this just keeps an
// allowed-path smoke assertion cheap.
const { runAegis } = vi.hoisted(() => ({ runAegis: vi.fn() }));
vi.mock('@/lib/aegis', () => ({
  runAegis,
  runAegisStreaming: vi.fn(),
  UsageRecorder: class {
    cost = { entries: () => [] };
    traceId = 't';
    setMeta() {}
    flush() {}
  },
}));

import { POST } from '../route';

function jsonReq(): NextRequest {
  return new NextRequest('http://localhost/api/aegis', {
    method: 'POST',
    headers: { Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'CONVERSATIONAL', message: 'Was ist DORA?' }),
  });
}

beforeEach(() => {
  runAegis.mockResolvedValue({
    text: 'ok', citations: [], conversationId: 'c1', modelUsed: 'm',
    iterations: 0, toolCalls: [], cost: { usd: 0 }, verify: { ok: true, checks: {} }, persisted: true,
  });
});
afterEach(() => {
  check.mockReset();
  runAegis.mockReset();
});

describe('POST /api/aegis — rate limit contract', () => {
  it('returns 429 + body + Retry-After when the limiter is exhausted', async () => {
    check.mockResolvedValue({ ok: false, remaining: 0, resetAt: Date.now() + 1000 });
    const res = await POST(jsonReq());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(runAegis).not.toHaveBeenCalled();
  });

  it('proceeds past the limiter when allowed', async () => {
    check.mockResolvedValue({ ok: true, remaining: 29, resetAt: Date.now() + 1000 });
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect(runAegis).toHaveBeenCalledOnce();
  });
});
