import { afterEach, describe, expect, it } from 'vitest';
import { createSession, verifySessionValue } from '@/lib/session';

// Snapshot only the keys these tests mutate; restore exactly after each case.
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

describe('session secret fail-closed', () => {
  it('throws in Vercel production when SESSION_SECRET is missing', () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.SESSION_SECRET;
    expect(() => createSession()).toThrow(/SESSION_SECRET/);
  });

  it('throws in Vercel preview when SESSION_SECRET is missing', () => {
    process.env.VERCEL_ENV = 'preview';
    delete process.env.SESSION_SECRET;
    expect(() => createSession()).toThrow(/SESSION_SECRET/);
  });

  it('throws on a NODE_ENV=production build when SESSION_SECRET is missing', () => {
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    delete process.env.SESSION_SECRET;
    expect(() => createSession()).toThrow(/SESSION_SECRET/);
  });

  it('throws when SESSION_SECRET is set but too short in a deployed env', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SESSION_SECRET = 'short';
    expect(() => createSession()).toThrow(/SESSION_SECRET/);
  });

  it('uses the dev fallback when not deployed and the secret is missing', () => {
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    delete process.env.SESSION_SECRET;
    const s = createSession();
    expect(verifySessionValue(s.value)).toBe(s.id);
  });

  it('signs and verifies normally in a deployed env when SESSION_SECRET is set', () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SESSION_SECRET = 'a-sufficiently-long-secret-value';
    const s = createSession();
    expect(verifySessionValue(s.value)).toBe(s.id);
  });
});
