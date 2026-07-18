import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: () => ({ ok: true }) }),
  ipHash: () => 'iphash',
}));

const { findUnique, update } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique, update } } }));

import { createResetToken, hashPassword, verifyPassword } from '@/lib/auth';
import { POST } from '../route';

const EMAIL = 'user@allow.test';

function resetReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const savedAllow = process.env.AUTH_ALLOWLIST;
beforeEach(() => {
  process.env.AUTH_ALLOWLIST = EMAIL;
  findUnique.mockReset();
  update.mockReset();
  update.mockResolvedValue({});
});
afterEach(() => {
  if (savedAllow === undefined) delete process.env.AUTH_ALLOWLIST;
  else process.env.AUTH_ALLOWLIST = savedAllow;
});

describe('POST /api/auth/reset', () => {
  it('valid token → sets a scrypt hash that round-trips with verifyPassword', async () => {
    const oldHash = hashPassword('old-password');
    findUnique.mockResolvedValue({ email: EMAIL, passwordHash: oldHash });
    let savedHash: string | undefined;
    update.mockImplementation(async ({ data }: { data: { passwordHash: string } }) => {
      savedHash = data.passwordHash;
      return {};
    });

    const token = createResetToken(EMAIL, oldHash);
    const res = await POST(resetReq({ token, password: 'a-new-password-123' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(savedHash).toBeTruthy();
    expect(verifyPassword('a-new-password-123', savedHash!)).toBe(true);
  });

  it('token minted against the OLD hash is rejected after the password changed', async () => {
    const oldHash = hashPassword('old-password');
    const token = createResetToken(EMAIL, oldHash);
    // Account already has a new hash (a prior reset happened).
    findUnique.mockResolvedValue({ email: EMAIL, passwordHash: hashPassword('already-reset') });

    const res = await POST(resetReq({ token, password: 'another-password-123' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(update).not.toHaveBeenCalled();
  });

  it('garbage token → 400, no update', async () => {
    findUnique.mockResolvedValue({ email: EMAIL, passwordHash: hashPassword('pw') });
    const res = await POST(resetReq({ token: 'not-a-real-token', password: 'whatever-123' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(update).not.toHaveBeenCalled();
  });

  it('expired token → 400, no update', async () => {
    const hash = hashPassword('pw');
    findUnique.mockResolvedValue({ email: EMAIL, passwordHash: hash });
    const token = createResetToken(EMAIL, hash, -1000);
    const res = await POST(resetReq({ token, password: 'a-new-password-123' }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('weak password (valid token) → 400, no update', async () => {
    const hash = hashPassword('pw');
    findUnique.mockResolvedValue({ email: EMAIL, passwordHash: hash });
    const token = createResetToken(EMAIL, hash);
    const res = await POST(resetReq({ token, password: 'short' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'weak_password' });
    expect(update).not.toHaveBeenCalled();
  });
});
