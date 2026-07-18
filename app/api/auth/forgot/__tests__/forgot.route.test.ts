import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Rate limiter: always allow.
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: () => ({ ok: true }) }),
  ipHash: () => 'iphash',
}));

// DB user table, controllable per test.
const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique } } }));

// Resend wrapper mocked — never sends real mail.
const { sendPasswordResetEmail } = vi.hoisted(() => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendPasswordResetEmail }));

import { hashPassword } from '@/lib/auth';
import { POST } from '../route';

const GENERIC = {
  ok: true,
  message:
    'Falls ein Konto zu dieser E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.',
};

function forgotReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function userRow(over: Record<string, unknown> = {}) {
  return { id: 'u1', email: 'user@allow.test', passwordHash: hashPassword('pw'), ...over };
}

const savedAllow = process.env.AUTH_ALLOWLIST;
beforeEach(() => {
  process.env.AUTH_ALLOWLIST = 'user@allow.test';
  findUnique.mockReset();
  sendPasswordResetEmail.mockReset();
  sendPasswordResetEmail.mockResolvedValue(undefined);
});
afterEach(() => {
  if (savedAllow === undefined) delete process.env.AUTH_ALLOWLIST;
  else process.env.AUTH_ALLOWLIST = savedAllow;
});

describe('POST /api/auth/forgot — anti-enumeration + Resend', () => {
  it('allowlisted + existing → generic 200 and an email is sent', async () => {
    findUnique.mockResolvedValue(userRow());
    const res = await POST(forgotReq({ email: 'user@allow.test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GENERIC);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const [to, url] = sendPasswordResetEmail.mock.calls[0];
    expect(to).toBe('user@allow.test');
    expect(String(url)).toContain('/reset-password?token=');
  });

  it('non-allowlisted → identical generic 200, NO email', async () => {
    findUnique.mockResolvedValue(userRow({ email: 'stranger@nope.test' }));
    const res = await POST(forgotReq({ email: 'stranger@nope.test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GENERIC);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('allowlisted but unknown account → identical generic 200, NO email', async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(forgotReq({ email: 'user@allow.test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GENERIC);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('Resend failure still yields the generic 200 (no leak, no 500)', async () => {
    findUnique.mockResolvedValue(userRow());
    sendPasswordResetEmail.mockRejectedValue(new Error('Resend send failed: boom'));
    const res = await POST(forgotReq({ email: 'user@allow.test' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(GENERIC);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('exposes NO token or link in the response body', async () => {
    findUnique.mockResolvedValue(userRow());
    const res = await POST(forgotReq({ email: 'user@allow.test' }));
    const json = await res.json();
    expect(json).not.toHaveProperty('resetUrl');
    expect(JSON.stringify(json)).not.toContain('token');
    expect(JSON.stringify(json)).not.toContain('reset-password');
  });
});
