import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Rate limiter: always allow, so tests exercise the auth gate, not throttling.
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: () => ({ ok: true, remaining: 1, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));

// DB user table: controllable per test. Real @/lib/auth is used (scrypt,
// allowlist, dummy hash) so the gate logic runs for real.
const { findUnique, update } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique, update } } }));

import { AUTH_COOKIE, hashPassword } from '@/lib/auth';
import { POST } from '../login/route';

const PASSWORD = 'correct horse battery';

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'user@allow.test',
    username: 'u',
    passwordHash: hashPassword(PASSWORD),
    status: 'APPROVED',
    role: 'USER',
    approvedAt: new Date(),
    ...over,
  };
}

function loginReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const savedAllow = process.env.AUTH_ALLOWLIST;
const savedAdmin = process.env.ADMIN_EMAILS;

beforeEach(() => {
  process.env.AUTH_ALLOWLIST = 'user@allow.test, admin@allow.test';
  process.env.ADMIN_EMAILS = 'admin@allow.test';
  findUnique.mockReset();
  update.mockReset();
});
afterEach(() => {
  if (savedAllow === undefined) delete process.env.AUTH_ALLOWLIST;
  else process.env.AUTH_ALLOWLIST = savedAllow;
  if (savedAdmin === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdmin;
});

describe('POST /api/auth/login — allowlist gate', () => {
  it('correct password + allowlisted + APPROVED → 200 + auth cookie', async () => {
    findUnique.mockResolvedValue(userRow());
    const res = await POST(loginReq({ email: 'user@allow.test', password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(AUTH_COOKIE)?.value).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it('email NOT on the allowlist → generic 401, no cookie (even with a valid account/password)', async () => {
    // A real, correct-password account whose email simply isn't allowlisted.
    findUnique.mockResolvedValue(userRow({ email: 'stranger@nope.test' }));
    const res = await POST(loginReq({ email: 'stranger@nope.test', password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' });
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it('wrong password → generic 401, no cookie', async () => {
    findUnique.mockResolvedValue(userRow());
    const res = await POST(loginReq({ email: 'user@allow.test', password: 'wrong' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' });
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it('BLOCKED account → generic 401 even with correct password + allowlist', async () => {
    findUnique.mockResolvedValue(userRow({ status: 'BLOCKED' }));
    const res = await POST(loginReq({ email: 'user@allow.test', password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' });
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });

  it('unknown email → generic 401 (dummy-hash path, no throw)', async () => {
    findUnique.mockResolvedValue(null);
    const res = await POST(loginReq({ email: 'user@allow.test', password: PASSWORD }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_credentials' });
    expect(res.cookies.get(AUTH_COOKIE)).toBeUndefined();
  });
});

describe('POST /api/auth/login — D7 self-registered accounts', () => {
  it('a verified self-registered user (NOT allowlisted) can log in', async () => {
    findUnique.mockResolvedValue(
      userRow({ email: 'self@registered.test', emailVerifiedAt: new Date(), status: 'PENDING' }),
    );
    const res = await POST(loginReq({ email: 'self@registered.test', password: PASSWORD }));
    expect(res.status).toBe(200);
  });

  it('an UNVERIFIED self-registered user gets the same generic 401', async () => {
    findUnique.mockResolvedValue(
      userRow({ email: 'self@registered.test', emailVerifiedAt: null, status: 'PENDING' }),
    );
    const res = await POST(loginReq({ email: 'self@registered.test', password: PASSWORD }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_credentials');
  });
});
