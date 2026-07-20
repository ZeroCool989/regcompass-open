import { decryptApiKey, encryptApiKey } from '../provider-settings';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkceVerifier,
  OAuthFlowError,
  pkceChallenge,
  refreshAccessToken,
  signOAuthState,
  verifyOAuthState,
} from './core';
import {
  isConfigured,
  oauthConfig,
  OAUTH_PROVIDER_IDS,
  OAUTH_PROVIDER_META,
  type OAuthProviderId,
} from './registry';
import {
  deleteConnection,
  readSecrets,
  saveConnection,
  setConnectionError,
  viewConnection,
  type ConnectionView,
} from './store';

/**
 * High-level subscription-connect orchestration for the local app. Combines the
 * standards-based OAuth core, the per-provider registry, and the local token
 * store. The callback runs on the app's own localhost route (loopback), and the
 * PKCE verifier travels in an encrypted httpOnly cookie so it is never readable
 * by browser scripts and is single-use per attempt.
 */

export const PKCE_COOKIE = 'rc_oauth_pkce';
const REFRESH_SKEW_MS = 60_000;

export function callbackPath(id: OAuthProviderId): string {
  return `/api/aegis/oauth/${id}/callback`;
}

export function callbackUrl(id: OAuthProviderId, origin: string): string {
  const base = process.env.APP_BASE_URL?.trim() || origin;
  return `${base}${callbackPath(id)}`;
}

// ── Status ───────────────────────────────────────────────────────────────────

export type ProviderStatus = 'unconfigured' | 'disconnected' | 'connected';

export type ProviderView = ConnectionView & {
  id: OAuthProviderId;
  label: string;
  brand: string;
  mark: string;
  loginHost: string;
  loginUrl: string;
  status: ProviderStatus;
  setupHint: string;
};

export function providerView(id: OAuthProviderId): ProviderView {
  const meta = OAUTH_PROVIDER_META[id];
  const connection = viewConnection(id);
  const status: ProviderStatus = !isConfigured(id)
    ? 'unconfigured'
    : connection.connected
      ? 'connected'
      : 'disconnected';
  return {
    id,
    label: meta.label,
    brand: meta.brand,
    mark: meta.mark,
    loginHost: meta.loginHost,
    loginUrl: meta.loginUrl,
    setupHint: meta.setupHint,
    status,
    ...connection,
  };
}

export function allProviderViews(): ProviderView[] {
  return OAUTH_PROVIDER_IDS.map(providerView);
}

// ── PKCE cookie (encrypted; opaque to the browser) ──────────────────────────

export type PkceCookiePayload = { provider: OAuthProviderId; state: string; verifier: string; userId: string };

export function encodePkceCookie(payload: PkceCookiePayload): string {
  return encryptApiKey(JSON.stringify(payload));
}

export function decodePkceCookie(raw: string): PkceCookiePayload | null {
  try {
    const p = JSON.parse(decryptApiKey(raw)) as Partial<PkceCookiePayload>;
    if (
      (p.provider === 'anthropic' || p.provider === 'openai' || p.provider === 'google') &&
      typeof p.state === 'string' &&
      typeof p.verifier === 'string' &&
      typeof p.userId === 'string'
    ) {
      return { provider: p.provider, state: p.state, verifier: p.verifier, userId: p.userId };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ── Start: build the authorize redirect + the cookie to pair with it ────────

export function startConnect(
  id: OAuthProviderId,
  userId: string,
  origin: string,
): { authorizeUrl: string; cookie: string } | null {
  const config = oauthConfig(id);
  if (!config) return null;
  const state = signOAuthState(id, userId);
  const verifier = generatePkceVerifier();
  const authorizeUrl = buildAuthorizeUrl({
    config,
    redirectUri: callbackUrl(id, origin),
    state,
    challenge: pkceChallenge(verifier),
    extra: OAUTH_PROVIDER_META[id].authorizeExtra,
  });
  return { authorizeUrl, cookie: encodePkceCookie({ provider: id, state, verifier, userId }) };
}

// ── Callback: validate + exchange + persist ─────────────────────────────────

export type CallbackOutcome = { ok: true } | { ok: false; reason: string };

export async function completeCallback(params: {
  id: OAuthProviderId;
  userId: string;
  origin: string;
  code: string;
  state: string;
  cookie: PkceCookiePayload | null;
  fetchImpl?: typeof fetch;
}): Promise<CallbackOutcome> {
  const config = oauthConfig(params.id);
  if (!config) return { ok: false, reason: 'setup' };
  const c = params.cookie;
  if (
    !c ||
    c.provider !== params.id ||
    c.state !== params.state ||
    c.userId !== params.userId ||
    !verifyOAuthState(params.state, params.id, params.userId)
  ) {
    return { ok: false, reason: 'state' };
  }
  try {
    const tokens = await exchangeCode({
      config,
      code: params.code,
      verifier: c.verifier,
      redirectUri: callbackUrl(params.id, params.origin),
      fetchImpl: params.fetchImpl,
    });
    saveConnection(params.id, tokens);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'exchange' };
  }
}

export function disconnect(id: OAuthProviderId): void {
  deleteConnection(id);
}

// ── Access token for the brain (auto-refresh) ───────────────────────────────

/**
 * Return a currently-valid access token for a connected provider, refreshing it
 * first when expired. Returns null when the provider is not connected or the
 * refresh fails (the caller then falls back to an API key / system default).
 * The failure is persisted to the connection's lastError for the UI, never
 * logged with token material.
 */
export async function getAccessToken(
  id: OAuthProviderId,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string | null> {
  const config = oauthConfig(id);
  if (!config) return null;
  const secrets = readSecrets(id);
  if (!secrets) return null;
  if (!secrets.expiresAt || secrets.expiresAt.getTime() - REFRESH_SKEW_MS > now) {
    return secrets.accessToken; // still fresh
  }
  if (!secrets.refreshToken) {
    setConnectionError(id, 'Die Verbindung ist abgelaufen. Bitte neu anmelden.');
    return null;
  }
  try {
    const refreshed = await refreshAccessToken({
      config,
      refreshToken: secrets.refreshToken,
      fetchImpl,
      now,
    });
    saveConnection(id, {
      ...refreshed,
      // Providers may omit the refresh token on refresh; keep the prior one.
      refreshToken: refreshed.refreshToken ?? secrets.refreshToken,
    });
    return refreshed.accessToken;
  } catch (err) {
    setConnectionError(
      id,
      err instanceof OAuthFlowError ? err.userMessage : 'Die Verbindung konnte nicht erneuert werden. Bitte neu anmelden.',
    );
    return null;
  }
}
