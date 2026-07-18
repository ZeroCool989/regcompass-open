import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

// SCOPE: these cover the JS-side contract only — ok/remaining computation, the
// fail-open fallback, and ipHash. The fixed-WINDOW / RESET / INCREMENT semantics
// live in the `INSERT … ON CONFLICT … now()/make_interval` SQL and are therefore
// PG-integration scope (a Testcontainers/real-Postgres test is the right home if
// we ever want them); reimplementing that SQL in a stub would prove nothing.

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $queryRaw: queryRaw } }));

import { ipHash, rateLimit } from '../rate-limit';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const reqWith = (xff: string | null): NextRequest =>
  ({ headers: { get: (h: string) => (h === 'x-forwarded-for' ? xff : null) } } as unknown as NextRequest);

afterEach(() => queryRaw.mockReset());

describe('ipHash', () => {
  it('hashes the first x-forwarded-for IP, deterministically', () => {
    expect(ipHash(reqWith('1.2.3.4, 5.6.7.8'))).toBe(sha('1.2.3.4'));
    expect(ipHash(reqWith('1.2.3.4'))).toBe(ipHash(reqWith('1.2.3.4'))); // stable
  });

  it('falls back to "unknown" when the header is absent', () => {
    expect(ipHash(reqWith(null))).toBe(sha('unknown'));
  });

  it('distinguishes different IPs', () => {
    expect(ipHash(reqWith('1.1.1.1'))).not.toBe(ipHash(reqWith('2.2.2.2')));
  });
});

describe('rateLimit.check — JS-side contract', () => {
  const limiter = () => rateLimit({ key: 'k', limit: 30, windowMs: 60_000 });

  it('ok with remaining when count <= limit', async () => {
    const resetAt = new Date(Date.now() + 60_000);
    queryRaw.mockResolvedValue([{ count: 1, resetAt }]);
    const r = await limiter().check('id');
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(29);
    expect(r.resetAt).toBe(resetAt.getTime());
  });

  it('ok at the exact limit, remaining 0', async () => {
    queryRaw.mockResolvedValue([{ count: 30, resetAt: new Date() }]);
    const r = await limiter().check('id');
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('not ok once count exceeds the limit', async () => {
    queryRaw.mockResolvedValue([{ count: 31, resetAt: new Date() }]);
    const r = await limiter().check('id');
    expect(r.ok).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('fails OPEN when the DB query throws (never takes the product down)', async () => {
    queryRaw.mockRejectedValue(new Error('db unreachable'));
    const r = await limiter().check('id');
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(30);
  });
});
