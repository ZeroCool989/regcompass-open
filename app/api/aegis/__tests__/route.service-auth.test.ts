import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Capture which limiter bucket (key) + identifier each call uses.
const { checkImpl } = vi.hoisted(() => ({ checkImpl: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (opts: { key: string }) => ({ check: (id: string) => checkImpl(opts.key, id) }),
  ipHash: () => 'iphash',
}));

// Cookie path: controllable per test.
const { readSessionId } = vi.hoisted(() => ({ readSessionId: vi.fn() }));
vi.mock('@/lib/session', () => ({ readSessionId }));
// Auth gate: the public/cookie path now requires an approved user. The
// service-token path bypasses it. Treat the browser caller as approved.
vi.mock('@/lib/aegis/soul-store', () => ({ buildUserSoulBlock: async () => null }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1', email: 'u@test', status: 'APPROVED', role: 'USER' }),
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));

// Stop before real model work; assert the sessionId the route resolves.
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

const TOKEN = 'route-service-token-xyz';
const saved = process.env.AEGIS_SERVICE_TOKEN;

function jsonReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/aegis', {
    method: 'POST',
    headers: { Accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ mode: 'CONVERSATIONAL', message: 'Was ist DORA?' }),
  });
}

beforeEach(() => {
  process.env.AEGIS_SERVICE_TOKEN = TOKEN;
  checkImpl.mockReturnValue({ ok: true, remaining: 1, resetAt: Date.now() + 1000 });
  readSessionId.mockReturnValue(null);
  runAegis.mockResolvedValue({
    text: 'ok', citations: [], conversationId: 'c1', modelUsed: 'm',
    iterations: 0, toolCalls: [], cost: { usd: 0 }, verify: { ok: true, checks: {} }, persisted: true,
  });
});
afterEach(() => {
  if (saved === undefined) delete process.env.AEGIS_SERVICE_TOKEN;
  else process.env.AEGIS_SERVICE_TOKEN = saved;
  checkImpl.mockReset();
  readSessionId.mockReset();
  runAegis.mockReset();
});

const sessionOf = () => runAegis.mock.calls[0]![2]!.sessionId;

describe('POST /api/aegis — service auth', () => {
  it('valid token + X-Aegis-Session → runs with the voice:-namespaced session', async () => {
    const res = await POST(jsonReq({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'demo-session-1' }));
    expect(res.status).toBe(200);
    expect(runAegis).toHaveBeenCalledOnce();
    expect(sessionOf()).toBe('voice:demo-session-1');
    // service path → its own limiter bucket, keyed by the namespaced session.
    expect(checkImpl).toHaveBeenCalledWith('aegis-service', 'voice:demo-session-1');
  });

  it('no token, no cookie → stateless (sessionId null), public limiter by ipHash', async () => {
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect(sessionOf()).toBeNull();
    expect(checkImpl).toHaveBeenCalledWith('aegis', 'iphash');
  });

  it('no token, with cookie → cookie session unchanged (byte-identical path)', async () => {
    readSessionId.mockReturnValue('browser-uuid-123');
    const res = await POST(jsonReq());
    expect(res.status).toBe(200);
    expect(sessionOf()).toBe('browser-uuid-123');
    expect(checkImpl).toHaveBeenCalledWith('aegis', 'iphash');
  });

  it('bad token → 401, runAegis not called', async () => {
    const res = await POST(jsonReq({ Authorization: 'Bearer wrong', 'X-Aegis-Session': 'demo-session-1' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    expect(runAegis).not.toHaveBeenCalled();
  });

  it('token present but AEGIS_SERVICE_TOKEN unset → 401 (fail-closed)', async () => {
    delete process.env.AEGIS_SERVICE_TOKEN;
    const res = await POST(jsonReq({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'demo-session-1' }));
    expect(res.status).toBe(401);
    expect(runAegis).not.toHaveBeenCalled();
  });

  it('valid token but missing / colon-bearing session id → 401', async () => {
    const missing = await POST(jsonReq({ Authorization: `Bearer ${TOKEN}` }));
    expect(missing.status).toBe(401);
    const colon = await POST(jsonReq({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'voice:evil' }));
    expect(colon.status).toBe(401);
    expect(runAegis).not.toHaveBeenCalled();
  });

  it('service rate limit is separate: exhausting it → 429 with the service message', async () => {
    checkImpl.mockImplementation((key: string) =>
      key === 'aegis-service'
        ? { ok: false, remaining: 0, resetAt: Date.now() + 1000 }
        : { ok: true, remaining: 1, resetAt: Date.now() + 1000 },
    );
    const res = await POST(jsonReq({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'demo-session-1' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect((await res.json()).message).toMatch(/AEGIS-Service-Limit/);
    expect(runAegis).not.toHaveBeenCalled();
  });

  it('public 429 message unchanged (no token)', async () => {
    checkImpl.mockReturnValue({ ok: false, remaining: 0, resetAt: Date.now() + 1000 });
    const res = await POST(jsonReq());
    expect(res.status).toBe(429);
    expect((await res.json()).message).toMatch(/30 Anfragen pro Stunde/);
  });
});
