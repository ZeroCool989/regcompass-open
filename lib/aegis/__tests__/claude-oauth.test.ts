import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  userClaudeOAuth: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ db: dbMock }));

import {
  buildAuthorizeUrl,
  claudeOAuthConfig,
  claudeOAuthStatus,
  decodePkceCookie,
  disconnect,
  encodePkceCookie,
  ensureFreshConnection,
  exchangeCode,
  generatePkceVerifier,
  pkceChallenge,
  refreshAccessToken,
  resolveCallbackUrl,
  signOAuthState,
  storeConnection,
  verifyOAuthState,
} from '../claude-oauth';
import { decryptApiKey, encryptApiKey } from '../provider-settings';

const CONFIG_ENV = {
  ANTHROPIC_OAUTH_CLIENT_ID: 'client-123',
  ANTHROPIC_OAUTH_TOKEN_URL: 'https://example.invalid/oauth/token',
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('claude-oauth config gate (D10)', () => {
  it('is unconfigured without an Anthropic-issued client', () => {
    expect(claudeOAuthStatus({} as unknown as NodeJS.ProcessEnv)).toBe('unconfigured');
    expect(claudeOAuthConfig({ ANTHROPIC_OAUTH_CLIENT_ID: 'x' } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(claudeOAuthConfig({ ANTHROPIC_OAUTH_TOKEN_URL: 'https://x' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('is ready only with client id AND token url; authorize url has a default', () => {
    const config = claudeOAuthConfig(CONFIG_ENV);
    expect(config).not.toBeNull();
    expect(config!.authorizeUrl).toBe('https://claude.ai/oauth/authorize');
    expect(claudeOAuthStatus(CONFIG_ENV)).toBe('ready');
  });
});

describe('PKCE', () => {
  it('produces RFC 7636 S256 challenges', () => {
    // RFC 7636 appendix B test vector
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const verifier = generatePkceVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });
});

describe('state parameter', () => {
  it('round-trips for the same user within the TTL', () => {
    const state = signOAuthState('user-1');
    expect(verifyOAuthState(state, 'user-1')).toBe(true);
  });

  it('rejects other users, tampering, and expiry', () => {
    const state = signOAuthState('user-1');
    expect(verifyOAuthState(state, 'user-2')).toBe(false);
    expect(verifyOAuthState(state + 'x', 'user-1')).toBe(false);
    expect(verifyOAuthState('not.a.state', 'user-1')).toBe(false);
    const past = signOAuthState('user-1', Date.now() - 11 * 60 * 1000);
    expect(verifyOAuthState(past, 'user-1')).toBe(false);
  });
});

describe('PKCE cookie payload', () => {
  it('round-trips encrypted and rejects garbage', () => {
    const payload = { state: 's', verifier: 'v', userId: 'u' };
    const raw = encodePkceCookie(payload);
    expect(raw).not.toContain('verifier');
    expect(decodePkceCookie(raw)).toEqual(payload);
    expect(decodePkceCookie('garbage')).toBeNull();
    expect(decodePkceCookie(encryptApiKey('"just-a-string"'))).toBeNull();
  });
});

describe('authorize url', () => {
  it('carries client_id, redirect, state, and S256 challenge', () => {
    const config = claudeOAuthConfig(CONFIG_ENV)!;
    const url = new URL(
      buildAuthorizeUrl({
        config,
        redirectUri: 'https://app.example/cb',
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
  });
});

describe('resolveCallbackUrl', () => {
  it('prefers APP_BASE_URL over the request origin', () => {
    const prev = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = 'https://regcompass.example';
    try {
      expect(resolveCallbackUrl('http://localhost:3000')).toBe(
        'https://regcompass.example/api/aegis/providers/claude-oauth/callback',
      );
    } finally {
      if (prev === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = prev;
    }
  });
});

describe('token grants (mocked endpoint)', () => {
  const config = claudeOAuthConfig(CONFIG_ENV)!;

  it('exchanges a code and parses expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const now = 1_000_000;
    const tokens = await exchangeCode({
      config, code: 'c', verifier: 'v', redirectUri: 'https://app/cb', fetchImpl, now,
    });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAt?.getTime()).toBe(now + 3_600_000);
    const body = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=v');
  });

  it('maps a rejected exchange to a German message without echoing the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ config, code: 'c', verifier: 'v', redirectUri: 'r', fetchImpl }),
    ).rejects.toMatchObject({ userMessage: expect.stringContaining('abgelehnt') });
  });

  it('refresh grant posts the refresh token', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'at2' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const tokens = await refreshAccessToken({ config, refreshToken: 'rt', fetchImpl });
    expect(tokens.accessToken).toBe('at2');
    const body = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(body).toContain('grant_type=refresh_token');
  });
});

describe('storage', () => {
  it('stores tokens encrypted — never plaintext', async () => {
    await storeConnection('user-1', {
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      tokenType: 'Bearer',
      scope: null,
      expiresAt: null,
    });
    const call = dbMock.userClaudeOAuth.upsert.mock.calls[0][0];
    expect(call.create.encryptedAccessToken).not.toContain('secret-access');
    expect(decryptApiKey(call.create.encryptedAccessToken)).toBe('secret-access');
    expect(decryptApiKey(call.create.encryptedRefreshToken)).toBe('secret-refresh');
  });

  it('disconnect deletes the row', async () => {
    await disconnect('user-1');
    expect(dbMock.userClaudeOAuth.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});

describe('ensureFreshConnection', () => {
  it('reports setup-required without config', async () => {
    const msg = await ensureFreshConnection('user-1');
    expect(msg).toContain('Setup erforderlich');
  });

  it('refreshes an expired connection and keeps the old refresh token when none returned', async () => {
    const prevId = process.env.ANTHROPIC_OAUTH_CLIENT_ID;
    const prevUrl = process.env.ANTHROPIC_OAUTH_TOKEN_URL;
    process.env.ANTHROPIC_OAUTH_CLIENT_ID = 'client-123';
    process.env.ANTHROPIC_OAUTH_TOKEN_URL = 'https://example.invalid/oauth/token';
    try {
      const now = Date.now();
      dbMock.userClaudeOAuth.findUnique.mockResolvedValue({
        userId: 'user-1',
        encryptedAccessToken: encryptApiKey('old-at'),
        encryptedRefreshToken: encryptApiKey('old-rt'),
        expiresAt: new Date(now - 1000),
      });
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'new-at', expires_in: 3600 }), { status: 200 }),
      ) as unknown as typeof fetch;
      const msg = await ensureFreshConnection('user-1', fetchImpl, now);
      expect(msg).toBeNull();
      const upsert = dbMock.userClaudeOAuth.upsert.mock.calls.at(-1)![0];
      expect(decryptApiKey(upsert.update.encryptedAccessToken)).toBe('new-at');
      expect(decryptApiKey(upsert.update.encryptedRefreshToken)).toBe('old-rt');
    } finally {
      if (prevId === undefined) delete process.env.ANTHROPIC_OAUTH_CLIENT_ID; else process.env.ANTHROPIC_OAUTH_CLIENT_ID = prevId;
      if (prevUrl === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN_URL; else process.env.ANTHROPIC_OAUTH_TOKEN_URL = prevUrl;
    }
  });

  it('persists a German error and asks to reconnect when refresh fails', async () => {
    const prevId = process.env.ANTHROPIC_OAUTH_CLIENT_ID;
    const prevUrl = process.env.ANTHROPIC_OAUTH_TOKEN_URL;
    process.env.ANTHROPIC_OAUTH_CLIENT_ID = 'client-123';
    process.env.ANTHROPIC_OAUTH_TOKEN_URL = 'https://example.invalid/oauth/token';
    try {
      const now = Date.now();
      dbMock.userClaudeOAuth.findUnique.mockResolvedValue({
        userId: 'user-1',
        encryptedAccessToken: encryptApiKey('old-at'),
        encryptedRefreshToken: encryptApiKey('old-rt'),
        expiresAt: new Date(now - 1000),
      });
      const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
      const msg = await ensureFreshConnection('user-1', fetchImpl, now);
      expect(msg).toBeTruthy();
      const update = dbMock.userClaudeOAuth.update.mock.calls.at(-1)![0];
      expect(update.data.lastError).toBe(msg);
    } finally {
      if (prevId === undefined) delete process.env.ANTHROPIC_OAUTH_CLIENT_ID; else process.env.ANTHROPIC_OAUTH_CLIENT_ID = prevId;
      if (prevUrl === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN_URL; else process.env.ANTHROPIC_OAUTH_TOKEN_URL = prevUrl;
    }
  });
});

describe('D10 runtime boundary', () => {
  it('resolveAnthropicCredential ignores OAuth connections until activation', async () => {
    // The seam is documented in provider-settings.ts; this test pins the
    // deliberate behavior so accidental wiring shows up as a test change.
    const { resolveAnthropicCredential } = await import('../provider-settings');
    const src = (await import('node:fs')).readFileSync(
      new URL('../provider-settings.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain('D10 ACTIVATION SEAM');
    expect(typeof resolveAnthropicCredential).toBe('function');
    expect(src).not.toContain('userClaudeOAuth'); // no OAuth lookup in the credential path yet
  });
});
