import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

// The local single-user build does not rate limit — every check is allowed.
// These cover the preserved no-op contract and the ipHash helper.

import { ipHash, rateLimit } from '../rate-limit';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const reqWith = (xff: string | null): NextRequest =>
  ({ headers: { get: (h: string) => (h === 'x-forwarded-for' ? xff : null) } } as unknown as NextRequest);

describe('ipHash', () => {
  it('hashes the first x-forwarded-for IP, deterministically', () => {
    expect(ipHash(reqWith('1.2.3.4, 5.6.7.8'))).toBe(sha('1.2.3.4'));
    expect(ipHash(reqWith('1.2.3.4'))).toBe(ipHash(reqWith('1.2.3.4'))); // stable
  });

  it('distinguishes different IPs', () => {
    expect(ipHash(reqWith('1.1.1.1'))).not.toBe(ipHash(reqWith('2.2.2.2')));
  });
});

describe('rateLimit.check — local no-op', () => {
  const limiter = () => rateLimit({ key: 'k', limit: 30, windowMs: 60_000 });

  it('always allows and reports the full budget as remaining', async () => {
    const r = await limiter().check('id');
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(30);
    expect(r.resetAt).toBeGreaterThan(Date.now());
  });
});
