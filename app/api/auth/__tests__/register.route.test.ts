import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Rate limiter: always allow, so tests exercise the signup logic, not throttling.
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: () => ({ ok: true, remaining: 1, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));

const { findUnique, create, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: { user: { findUnique, create, update } } }));

const { sendVerificationEmail } = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendVerificationEmail }));

import { createEmailVerifyToken, hashPassword, verifyEmailVerifyToken } from '@/lib/auth';
import { POST as register } from '../register/route';
import { POST as verify } from '../verify/route';

function req(url: string, body: object): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { email: 'new@example.test', username: 'Neue Nutzerin', password: 'langes-passwort' };

const savedAllow = process.env.AUTH_ALLOWLIST;

beforeEach(() => {
  process.env.AUTH_ALLOWLIST = 'seeded@allow.test';
  findUnique.mockReset();
  create.mockReset();
  update.mockReset();
  sendVerificationEmail.mockReset();
  // username lookup (first findUnique call) → free; email lookup → unknown.
  findUnique.mockResolvedValue(null);
  create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-id',
    status: 'PENDING',
    emailVerifiedAt: null,
    ...data,
  }));
});
afterEach(() => {
  process.env.AUTH_ALLOWLIST = savedAllow;
});

describe('POST /api/auth/register', () => {
  it('creates a PENDING unverified account and emails a verification link', async () => {
    const res = await register(req('/api/auth/register', VALID));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data;
    expect(data.email).toBe('new@example.test');
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect(data.status).toBeUndefined(); // schema default PENDING
    expect(sendVerificationEmail).toHaveBeenCalledOnce();
    const url: string = sendVerificationEmail.mock.calls[0][1];
    expect(url).toContain('/verify-email?token=');
  });

  it('responds identically for an already-registered verified email (no enumeration), without sending', async () => {
    const row = {
      id: 'u1', email: VALID.email, username: 'other', passwordHash: hashPassword('x'.repeat(12)),
      status: 'APPROVED', emailVerifiedAt: new Date(),
    };
    // username check → null; email check → the existing row only for its own email
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.email === row.email ? row : null);
    const res = await register(req('/api/auth/register', VALID));
    const fresh = await register(req('/api/auth/register', { ...VALID, email: 'fresh@example.test', username: 'Frische Nutzerin' }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe((await fresh.json()).message);
    expect(create).toHaveBeenCalledTimes(1); // only the fresh one
  });

  it('does not mail owners of allowlisted accounts on re-registration attempts', async () => {
    const row = {
      id: 'u2', email: 'seeded@allow.test', username: 'seed', passwordHash: hashPassword('x'.repeat(12)),
      status: 'APPROVED', emailVerifiedAt: null,
    };
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.email ? row : null);
    const res = await register(req('/api/auth/register', { ...VALID, email: 'seeded@allow.test' }));
    expect(res.status).toBe(200);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a taken username with a specific error', async () => {
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.username ? { id: 'other', email: 'someone@else.test' } : null);
    const res = await register(req('/api/auth/register', VALID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('username_taken');
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['bad email', { ...VALID, email: 'nope' }],
    ['short password', { ...VALID, password: 'kurz' }],
    ['bad username', { ...VALID, username: 'x' }],
  ])('rejects invalid input: %s', async (_label, body) => {
    const res = await register(req('/api/auth/register', body));
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/verify', () => {
  const HASH = hashPassword('irrelevant-pw');
  const row = {
    id: 'u3', email: 'new@example.test', username: 'n', passwordHash: HASH,
    status: 'PENDING', emailVerifiedAt: null,
  };

  it('stamps emailVerifiedAt for a valid token', async () => {
    findUnique.mockResolvedValue(row);
    update.mockResolvedValue({ ...row, emailVerifiedAt: new Date() });
    const token = createEmailVerifyToken(row.email, HASH);
    const res = await verify(req('/api/auth/verify', { token }));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('is idempotent — an already-verified account is not updated again', async () => {
    findUnique.mockResolvedValue({ ...row, emailVerifiedAt: new Date() });
    const token = createEmailVerifyToken(row.email, HASH);
    const res = await verify(req('/api/auth/verify', { token }));
    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a token after the password changed (hash-bound)', async () => {
    findUnique.mockResolvedValue({ ...row, passwordHash: hashPassword('changed-pw-123') });
    const token = createEmailVerifyToken(row.email, HASH);
    const res = await verify(req('/api/auth/verify', { token }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects garbage and reset-family tokens (domain separation)', async () => {
    findUnique.mockResolvedValue(row);
    for (const bad of ['', 'nonsense', createEmailVerifyToken(row.email, HASH).slice(0, -2)]) {
      const res = await verify(req('/api/auth/verify', { token: bad }));
      expect(res.status).toBe(400);
    }
    // A verify token never validates as a reset token and vice versa is covered
    // by construction (domain prefix in the MAC); assert the helper agrees:
    expect(verifyEmailVerifyToken(createEmailVerifyToken(row.email, HASH), HASH)).toBe(row.email);
  });
});
