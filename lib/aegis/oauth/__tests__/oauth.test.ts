import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAuthorizeUrl,
  exchangeCode,
  pkceChallenge,
  refreshAccessToken,
  signOAuthState,
  verifyOAuthState,
  type OAuthConfig,
} from '../core';
import { oauthConfig, parseProviderId } from '../registry';
import {
  deleteConnection,
  readSecrets,
  saveConnection,
  storeDir,
  viewConnection,
} from '../store';
import {
  completeCallback,
  decodePkceCookie,
  encodePkceCookie,
  getAccessToken,
  providerView,
  startConnect,
} from '../index';

const CONFIG: OAuthConfig = {
  clientId: 'client-123',
  clientSecret: null,
  authorizeUrl: 'https://provider.example/oauth/authorize',
  tokenUrl: 'https://provider.example/oauth/token',
  scopes: 'openid offline_access',
};

// ── PKCE (RFC 7636 Appendix B known-answer vector) ──────────────────────────

describe('PKCE', () => {
  it('produces the RFC 7636 reference challenge for the reference verifier', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

// ── State: bound, expiring, tamper-evident ──────────────────────────────────

describe('OAuth state', () => {
  it('round-trips for the same provider + user', () => {
    const state = signOAuthState('anthropic', 'user-1');
    expect(verifyOAuthState(state, 'anthropic', 'user-1')).toBe(true);
  });

  it('rejects a different user, provider, tamper, or expiry', () => {
    const now = 1_000_000;
    const state = signOAuthState('anthropic', 'user-1', now);
    expect(verifyOAuthState(state, 'anthropic', 'user-2', now)).toBe(false);
    expect(verifyOAuthState(state, 'openai', 'user-1', now)).toBe(false);
    expect(verifyOAuthState(state + 'x', 'anthropic', 'user-1', now)).toBe(false);
    expect(verifyOAuthState(state, 'anthropic', 'user-1', now + 11 * 60 * 1000)).toBe(false);
  });
});

// ── Authorize URL ────────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('carries PKCE S256, client, redirect, state, scope, and extras', () => {
    const url = new URL(
      buildAuthorizeUrl({
        config: CONFIG,
        redirectUri: 'http://localhost:3000/api/aegis/oauth/anthropic/callback',
        state: 'st',
        challenge: 'ch',
        extra: { access_type: 'offline' },
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid offline_access');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });
});

// ── Token grants (mocked fetch) ─────────────────────────────────────────────

function mockFetch(payload: Record<string, unknown>, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 400,
      json: async () => payload,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('token grants', () => {
  it('exchanges an authorization code into tokens', async () => {
    const tokens = await exchangeCode({
      config: CONFIG,
      code: 'abc',
      verifier: 'v',
      redirectUri: 'http://localhost:3000/cb',
      fetchImpl: mockFetch({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      now: 0,
    });
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    expect(tokens.expiresAt?.getTime()).toBe(3600 * 1000);
  });

  it('refreshes an access token', async () => {
    const tokens = await refreshAccessToken({
      config: CONFIG,
      refreshToken: 'RT',
      fetchImpl: mockFetch({ access_token: 'AT2', expires_in: 3600 }),
      now: 0,
    });
    expect(tokens.accessToken).toBe('AT2');
  });

  it('throws a user-safe error on a rejected grant', async () => {
    await expect(
      exchangeCode({
        config: CONFIG,
        code: 'bad',
        verifier: 'v',
        redirectUri: 'http://localhost:3000/cb',
        fetchImpl: mockFetch({ error: 'invalid_grant' }, false),
      }),
    ).rejects.toThrow();
  });
});

// ── Registry ─────────────────────────────────────────────────────────────────

describe('registry', () => {
  it('is unconfigured without a client id, configured with one', () => {
    expect(oauthConfig('openai', {})).toBeNull();
    const cfg = oauthConfig('openai', { OPENAI_OAUTH_CLIENT_ID: 'cid' });
    expect(cfg?.clientId).toBe('cid');
    // OpenAI has public authorize/token defaults, so a client id alone suffices.
    expect(cfg?.tokenUrl).toContain('http');
  });

  it('anthropic needs an explicit token url (no public default)', () => {
    expect(oauthConfig('anthropic', { ANTHROPIC_OAUTH_CLIENT_ID: 'cid' })).toBeNull();
    expect(
      oauthConfig('anthropic', {
        ANTHROPIC_OAUTH_CLIENT_ID: 'cid',
        ANTHROPIC_OAUTH_TOKEN_URL: 'https://x/token',
        ANTHROPIC_OAUTH_AUTHORIZE_URL: 'https://x/auth',
      }),
    ).not.toBeNull();
  });

  it('parses only known provider ids', () => {
    expect(parseProviderId('google')).toBe('google');
    expect(parseProviderId('nope')).toBeNull();
  });
});

// ── Local store (isolated temp dir) ─────────────────────────────────────────

describe('credential store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rco-oauth-'));
    process.env.REGCOMPASS_OPEN_DIR = dir;
  });
  afterEach(() => {
    delete process.env.REGCOMPASS_OPEN_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips encrypted secrets and reports a connection view', () => {
    expect(viewConnection('openai').connected).toBe(false);
    saveConnection('openai', {
      accessToken: 'AT',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      scope: 'x',
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const secrets = readSecrets('openai');
    expect(secrets?.accessToken).toBe('AT');
    expect(secrets?.refreshToken).toBe('RT');
    expect(viewConnection('openai').connected).toBe(true);
    deleteConnection('openai');
    expect(readSecrets('openai')).toBeNull();
  });

  it('writes the store file with owner-only permissions', () => {
    saveConnection('google', {
      accessToken: 'AT',
      refreshToken: null,
      tokenType: 'Bearer',
      scope: null,
      expiresAt: null,
    });
    if (process.platform !== 'win32') {
      const mode = statSync(join(storeDir(), 'auth.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

// ── PKCE cookie ──────────────────────────────────────────────────────────────

describe('PKCE cookie', () => {
  it('round-trips and rejects tampered/foreign payloads', () => {
    const enc = encodePkceCookie({ provider: 'openai', state: 's', verifier: 'v', userId: 'u' });
    expect(decodePkceCookie(enc)).toEqual({ provider: 'openai', state: 's', verifier: 'v', userId: 'u' });
    expect(decodePkceCookie('garbage')).toBeNull();
  });
});

// ── Orchestration: status, callback, refresh precedence ─────────────────────

describe('orchestration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rco-oauth2-'));
    process.env.REGCOMPASS_OPEN_DIR = dir;
  });
  afterEach(() => {
    delete process.env.REGCOMPASS_OPEN_DIR;
    for (const k of ['OPENAI_OAUTH_CLIENT_ID']) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unconfigured → disconnected → connected', () => {
    expect(providerView('openai').status).toBe('unconfigured');
    process.env.OPENAI_OAUTH_CLIENT_ID = 'cid';
    expect(providerView('openai').status).toBe('disconnected');
    saveConnection('openai', {
      accessToken: 'AT',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      scope: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(providerView('openai').status).toBe('connected');
  });

  it('startConnect returns null when unconfigured, a url+cookie when configured', () => {
    expect(startConnect('openai', 'u', 'http://localhost:3000')).toBeNull();
    process.env.OPENAI_OAUTH_CLIENT_ID = 'cid';
    const started = startConnect('openai', 'u', 'http://localhost:3000');
    expect(started?.authorizeUrl).toContain('client_id=cid');
    expect(decodePkceCookie(started!.cookie)?.provider).toBe('openai');
  });

  it('completeCallback rejects a mismatched state', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'cid';
    const out = await completeCallback({
      id: 'openai',
      userId: 'u',
      origin: 'http://localhost:3000',
      code: 'c',
      state: 'wrong',
      cookie: { provider: 'openai', state: 'right', verifier: 'v', userId: 'u' },
    });
    expect(out).toEqual({ ok: false, reason: 'state' });
  });

  it('getAccessToken returns a fresh token and auto-refreshes an expired one', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'cid';
    // Fresh token → returned as-is (no fetch).
    saveConnection('openai', {
      accessToken: 'FRESH',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      scope: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    expect(await getAccessToken('openai')).toBe('FRESH');

    // Expired token with a refresh token → refreshed.
    saveConnection('openai', {
      accessToken: 'OLD',
      refreshToken: 'RT',
      tokenType: 'Bearer',
      scope: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    const refreshed = await getAccessToken('openai', mockFetch({ access_token: 'NEW', expires_in: 3600 }));
    expect(refreshed).toBe('NEW');
    expect(readSecrets('openai')?.accessToken).toBe('NEW');
  });

  it('getAccessToken returns null when not connected (caller falls back to a key)', async () => {
    process.env.OPENAI_OAUTH_CLIENT_ID = 'cid';
    expect(await getAccessToken('openai')).toBeNull();
  });
});
