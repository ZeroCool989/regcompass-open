import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: async () => ({ ok: true, remaining: 1, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => ({ id: 'u1', status: 'APPROVED' }),
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));

import { POST } from '../route';

const req = () =>
  new NextRequest('http://localhost/api/aegis/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Hallo Welt' }),
  });

const savedKey = process.env.CARTESIA_API_KEY;
beforeEach(() => {
  process.env.CARTESIA_API_KEY = 'test-key';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.CARTESIA_API_KEY;
  else process.env.CARTESIA_API_KEY = savedKey;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TTS provider-limit fallback', () => {
  it.each([429, 402, 401, 403])(
    'maps Cartesia %s (limit/quota/auth) → 503 with fallback:browser',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status })));
      const res = await POST(req());
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('tts_limit');
      expect(body.fallback).toBe('browser');
    },
  );

  it('a generic upstream 500 → 502, also signalling browser fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).fallback).toBe('browser');
  });

  it('an unreachable provider → 502 with fallback:browser', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect((await res.json()).fallback).toBe('browser');
  });

  it('503 tts_not_configured when no API key', async () => {
    delete process.env.CARTESIA_API_KEY;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('tts_not_configured');
  });
});
