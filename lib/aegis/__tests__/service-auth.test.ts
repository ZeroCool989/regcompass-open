import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { resolveServiceAuth } from '../service-auth';

const TOKEN = 'test-service-token-abc123';

function req(headers: Record<string, string>): NextRequest {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (k: string) => lower[k.toLowerCase()] ?? null } } as unknown as NextRequest;
}

const saved = process.env.AEGIS_SERVICE_TOKEN;
beforeEach(() => {
  process.env.AEGIS_SERVICE_TOKEN = TOKEN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AEGIS_SERVICE_TOKEN;
  else process.env.AEGIS_SERVICE_TOKEN = saved;
});

describe('resolveServiceAuth', () => {
  it('no Authorization header → none (unchanged public/cookie path)', () => {
    expect(resolveServiceAuth(req({}))).toEqual({ kind: 'none' });
  });

  it('malformed Authorization → invalid', () => {
    const r = resolveServiceAuth(req({ Authorization: 'Token xyz' }));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'malformed_authorization' });
  });

  it('fail-closed when the secret is unset but a Bearer is presented', () => {
    delete process.env.AEGIS_SERVICE_TOKEN;
    const r = resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'sess-abc1' }));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'service_auth_unconfigured' });
  });

  it('wrong token → invalid (bad_token)', () => {
    const r = resolveServiceAuth(req({ Authorization: 'Bearer not-the-token', 'X-Aegis-Session': 'sess-abc1' }));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'bad_token' });
  });

  it('a wrong token of DIFFERENT length is still rejected (length not a side channel)', () => {
    const r = resolveServiceAuth(req({ Authorization: 'Bearer x', 'X-Aegis-Session': 'sess-abc1' }));
    expect(r.kind).toBe('invalid');
  });

  it('valid token + good session id → valid, namespaced under voice:', () => {
    const r = resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'demo-session-1' }));
    expect(r).toEqual({ kind: 'valid', sessionId: 'voice:demo-session-1' });
  });

  it('valid token but missing session id → invalid', () => {
    const r = resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}` }));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'bad_session_id' });
  });

  it('rejects a session id containing ":" (cannot escape the namespace)', () => {
    const r = resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'voice:evil' }));
    expect(r).toMatchObject({ kind: 'invalid', reason: 'bad_session_id' });
  });

  it('rejects too-short / bad-charset session ids', () => {
    expect(resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'short' })).kind).toBe('invalid');
    expect(resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': 'has spaces!!' })).kind).toBe('invalid');
  });

  it('IDOR: a supplied bare-UUID becomes voice:<uuid>, never equal to the raw UUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const r = resolveServiceAuth(req({ Authorization: `Bearer ${TOKEN}`, 'X-Aegis-Session': uuid }));
    expect(r).toEqual({ kind: 'valid', sessionId: `voice:${uuid}` });
    if (r.kind === 'valid') expect(r.sessionId).not.toBe(uuid);
  });
});
