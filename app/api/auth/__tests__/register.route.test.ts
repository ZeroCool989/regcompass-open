import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Rate limiter: always allow, so tests exercise the signup logic, not throttling.
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: () => ({ ok: true, remaining: 1, resetAt: Date.now() + 1000 }) }),
  ipHash: () => 'iphash',
}));

// db.user.* answers the outer username/email checks; $transaction hands the
// route a tx facade so the bootstrap-count + create + legacy-migration calls
// are observable per test.
const { findUnique, tx } = vi.hoisted(() => {
  const tx = {
    user: {
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    aegisConversation: { updateMany: vi.fn() },
    userAiCredential: { updateMany: vi.fn() },
    userClaudeOAuth: { updateMany: vi.fn() },
    soulEntry: { updateMany: vi.fn() },
    soulProposal: { updateMany: vi.fn() },
    soulAudit: { updateMany: vi.fn() },
  };
  return { findUnique: vi.fn(), tx };
});
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

import { POST as register } from '../register/route';

function req(body: object): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { email: 'new@example.test', username: 'Neue Nutzerin', password: 'langes-passwort' };

const savedAllow = process.env.AUTH_ALLOWLIST;
const savedAdmin = process.env.ADMIN_EMAILS;

beforeEach(() => {
  delete process.env.AUTH_ALLOWLIST;
  delete process.env.ADMIN_EMAILS;
  findUnique.mockReset();
  findUnique.mockResolvedValue(null); // username + email are free
  for (const model of Object.values(tx)) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  tx.user.findUnique.mockResolvedValue(null); // no legacy `local` row
  tx.user.count.mockResolvedValue(0);
  tx.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'new-id',
    ...data,
  }));
});
afterEach(() => {
  if (savedAllow === undefined) delete process.env.AUTH_ALLOWLIST;
  else process.env.AUTH_ALLOWLIST = savedAllow;
  if (savedAdmin === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdmin;
});

describe('POST /api/auth/register — bootstrap', () => {
  it('first account on a fresh DB becomes an APPROVED ADMIN, login-ready', async () => {
    tx.user.count.mockResolvedValue(0);
    const res = await register(req(VALID));
    expect(res.status).toBe(200);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.role).toBe('ADMIN');
    expect(data.status).toBe('APPROVED');
    expect(data.approvedAt).toBeInstanceOf(Date);
    expect(data.emailVerifiedAt).toBeInstanceOf(Date); // offline build: no email round-trip
    expect(data.passwordHash).toMatch(/^scrypt\$/);
    expect((await res.json()).status).toBe('APPROVED');
  });

  it('later accounts are created as PENDING USER awaiting approval', async () => {
    tx.user.count.mockResolvedValue(1);
    const res = await register(req(VALID));
    expect(res.status).toBe(200);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.role).toBe('USER');
    expect(data.status).toBe('PENDING');
    expect(data.approvedAt).toBeNull();
    expect((await res.json()).status).toBe('PENDING');
  });

  it('ADMIN_EMAILS accounts are admitted as approved admins even when not first', async () => {
    process.env.ADMIN_EMAILS = VALID.email;
    tx.user.count.mockResolvedValue(3);
    await register(req(VALID));
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.role).toBe('ADMIN');
    expect(data.status).toBe('APPROVED');
  });
});

describe('POST /api/auth/register — legacy single-user migration', () => {
  const legacy = {
    id: 'local',
    email: 'local@regcompass.open',
    username: 'Local',
    passwordHash: '',
    voiceId: 'v1',
    voicePrefs: { speed: 1 },
    preferredAiProvider: 'ANTHROPIC',
  };

  it('hands the legacy local user’s data to the first admin and deletes the row', async () => {
    tx.user.findUnique.mockResolvedValue(legacy);
    tx.user.count.mockResolvedValue(0); // the passwordless row does not count
    const res = await register(req(VALID));
    expect(res.status).toBe(200);
    const data = tx.user.create.mock.calls[0][0].data;
    expect(data.role).toBe('ADMIN');
    expect(data.voiceId).toBe('v1');
    expect(data.preferredAiProvider).toBe('ANTHROPIC');
    const move = { where: { userId: 'local' }, data: { userId: 'new-id' } };
    expect(tx.aegisConversation.updateMany).toHaveBeenCalledWith(move);
    expect(tx.userAiCredential.updateMany).toHaveBeenCalledWith(move);
    expect(tx.userClaudeOAuth.updateMany).toHaveBeenCalledWith(move);
    expect(tx.soulEntry.updateMany).toHaveBeenCalledWith(move);
    expect(tx.soulProposal.updateMany).toHaveBeenCalledWith(move);
    expect(tx.soulAudit.updateMany).toHaveBeenCalledWith(move);
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'local' } });
  });

  it('does not migrate when a real account already exists', async () => {
    tx.user.findUnique.mockResolvedValue(legacy);
    tx.user.count.mockResolvedValue(1);
    await register(req(VALID));
    expect(tx.aegisConversation.updateMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.user.create.mock.calls[0][0].data.status).toBe('PENDING');
  });
});

describe('POST /api/auth/register — gates and validation', () => {
  it('open registration by default (no allowlist set)', async () => {
    const res = await register(req(VALID));
    expect(res.status).toBe(200);
  });

  it('AUTH_ALLOWLIST restricts registration to listed emails', async () => {
    process.env.AUTH_ALLOWLIST = 'invited@example.test';
    const rejected = await register(req(VALID));
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error).toBe('not_allowlisted');
    expect(tx.user.create).not.toHaveBeenCalled();

    const invited = await register(
      req({ ...VALID, email: 'invited@example.test' }),
    );
    expect(invited.status).toBe(200);
  });

  it('rejects a taken username with a specific error', async () => {
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.username ? { id: 'other' } : null);
    const res = await register(req(VALID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('username_taken');
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('rejects an already-registered email with a specific error', async () => {
    findUnique.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.email ? { id: 'other' } : null);
    const res = await register(req(VALID));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('email_taken');
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['bad email', { ...VALID, email: 'nope' }],
    ['short password', { ...VALID, password: 'kurz' }],
    ['bad username', { ...VALID, username: 'x' }],
  ])('rejects invalid input: %s', async (_label, body) => {
    const res = await register(req(body));
    expect(res.status).toBe(400);
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});
