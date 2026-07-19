import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { ipHash, rateLimit } from '../rate-limit';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const reqWith = (xff: string | null): NextRequest =>
  ({ headers: { get: (h: string) => (h === 'x-forwarded-for' ? xff : null) } } as unknown as NextRequest);

afterEach(() => vi.useRealTimers());

describe('ipHash', () => {
  it('hashes the first x-forwarded-for IP, deterministically', () => {
    expect(ipHash(reqWith('1.2.3.4, 5.6.7.8'))).toBe(sha('1.2.3.4'));
    expect(ipHash(reqWith('1.2.3.4'))).toBe(ipHash(reqWith('1.2.3.4'))); // stable
  });

  it('distinguishes different IPs', () => {
    expect(ipHash(reqWith('1.1.1.1'))).not.toBe(ipHash(reqWith('2.2.2.2')));
  });
});

describe('rateLimit.check — in-memory fixed window', () => {
  it('allows up to the limit, then rejects within the window', async () => {
    const limiter = rateLimit({ key: 'k1', limit: 3, windowMs: 60_000 });
    expect((await limiter.check('id')).ok).toBe(true);
    expect((await limiter.check('id')).ok).toBe(true);
    const third = await limiter.check('id');
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    expect((await limiter.check('id')).ok).toBe(false);
  });

  it('tracks identifiers independently', async () => {
    const limiter = rateLimit({ key: 'k2', limit: 1, windowMs: 60_000 });
    expect((await limiter.check('a')).ok).toBe(true);
    expect((await limiter.check('a')).ok).toBe(false);
    expect((await limiter.check('b')).ok).toBe(true);
  });

  it('resets after the window elapses', async () => {
    vi.useFakeTimers();
    const limiter = rateLimit({ key: 'k3', limit: 1, windowMs: 60_000 });
    expect((await limiter.check('id')).ok).toBe(true);
    expect((await limiter.check('id')).ok).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect((await limiter.check('id')).ok).toBe(true);
  });
});
