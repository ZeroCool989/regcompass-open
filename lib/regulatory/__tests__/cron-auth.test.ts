import { describe, it, expect } from 'vitest';
import { checkCronAuth } from '../cron-auth';

describe('checkCronAuth', () => {
  it('accepts a request with the matching Bearer secret', () => {
    expect(checkCronAuth('Bearer s3cret', { secret: 's3cret', deployed: true })).toEqual({ ok: true });
  });

  it('rejects a wrong or missing Bearer when a secret is set (401)', () => {
    expect(checkCronAuth('Bearer wrong', { secret: 's3cret', deployed: true })).toMatchObject({ ok: false, status: 401 });
    expect(checkCronAuth(null, { secret: 's3cret', deployed: true })).toMatchObject({ ok: false, status: 401 });
  });

  it('fails LOUD (503) when deployed without a secret — never run open', () => {
    expect(checkCronAuth(null, { secret: undefined, deployed: true })).toMatchObject({
      ok: false,
      status: 503,
      error: 'cron_secret_missing',
    });
  });

  it('stays curl-able locally (no secret, not deployed)', () => {
    expect(checkCronAuth(null, { secret: undefined, deployed: false })).toEqual({ ok: true });
  });
});
