import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

const saved = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

function request(): NextRequest {
  return new NextRequest('http://localhost/');
}

describe('proxy session issuance fail-closed', () => {
  it('throws in a deployed env when SESSION_SECRET is missing', async () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.SESSION_SECRET;
    await expect(proxy(request())).rejects.toThrow(/SESSION_SECRET/);
  });

  it('issues a signed cookie in dev when the secret is missing', async () => {
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    delete process.env.SESSION_SECRET;
    const res = await proxy(request());
    expect(res.cookies.get('rc_session')?.value).toMatch(/\./);
  });

  it('issues a signed cookie in a deployed env when the secret is set', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SESSION_SECRET = 'a-sufficiently-long-secret-value';
    const res = await proxy(request());
    expect(res.cookies.get('rc_session')?.value).toMatch(/\./);
  });
});
