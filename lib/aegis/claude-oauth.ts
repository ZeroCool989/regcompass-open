import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from './provider-settings';

/**
 * "Sign in with Claude" (D10) — subscription connect for RegCompass.
 *
 * IMPORTANT: this feature is APPROVAL-GATED by Anthropic. There is no public
 * self-service client registration, and Anthropic's policy prohibits routing
 * requests through users' Claude subscriptions without an issued client.
 * Everything here therefore activates only when the env vars below are set
 * (which only an Anthropic approval can provide). Until then the UI shows an
 * honest "Setup erforderlich" state. See docs/aegis/SIGN_IN_WITH_CLAUDE.md.
 *
 * Deliberately NOT wired into AEGIS calls: the API contract for
 * subscription-billed requests is part of the approval package. The runtime
 * seam is resolveAnthropicCredential() in provider-settings.ts.
 */

export type ClaudeOAuthStatus = 'unconfigured' | 'ready';

export type ClaudeOAuthConfig = {
  clientId: string;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string | null;
};

/** Default is the observed claude.ai authorize surface; env-overridable. */
const DEFAULT_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const STATE_TTL_MS = 10 * 60 * 1000;

export function claudeOAuthConfig(env: NodeJS.ProcessEnv = process.env): ClaudeOAuthConfig | null {
  const clientId = env.ANTHROPIC_OAUTH_CLIENT_ID?.trim();
  // The token endpoint is NOT guessed — it comes from Anthropic at approval.
  const tokenUrl = env.ANTHROPIC_OAUTH_TOKEN_URL?.trim();
  if (!clientId || !tokenUrl) return null;
  return {
    clientId,
    clientSecret: env.ANTHROPIC_OAUTH_CLIENT_SECRET?.trim() || null,
    authorizeUrl: env.ANTHROPIC_OAUTH_AUTHORIZE_URL?.trim() || DEFAULT_AUTHORIZE_URL,
    tokenUrl,
    scopes: env.ANTHROPIC_OAUTH_SCOPES?.trim() || null,
  };
}

export function claudeOAuthStatus(env: NodeJS.ProcessEnv = process.env): ClaudeOAuthStatus {
  return claudeOAuthConfig(env) ? 'ready' : 'unconfigured';
}

function deployedEnv(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview'
  );
}

/**
 * The redirect URI registered with Anthropic. Same SEC-1 rule as password
 * reset: in deployed envs never derive an outward-facing URL from a spoofable
 * Host header — APP_BASE_URL must be set.
 */
export function resolveCallbackUrl(requestOrigin: string): string {
  if (!process.env.APP_BASE_URL && deployedEnv()) {
    throw new Error('APP_BASE_URL must be set in deployed environments.');
  }
  const base = process.env.APP_BASE_URL || requestOrigin;
  return `${base}/api/aegis/providers/claude-oauth/callback`;
}

export const SETUP_REQUIRED_MESSAGE =
  'Setup erforderlich: RegCompass wartet auf die Freischaltung als offizielle Claude-App durch Anthropic. ' +
  'Bis dahin funktioniert Ihr eigener Anthropic API-Schlüssel bereits heute (Konto → AI-Provider).';

// ── PKCE (RFC 7636, S256) ────────────────────────────────────────────────────

export function generatePkceVerifier(): string {
  return randomBytes(48).toString('base64url'); // 64 chars, within 43–128
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── State: HMAC-bound to the user, expiring, tamper-evident ─────────────────
// Single-use is enforced by the paired httpOnly cookie: the callback clears it,
// and without the cookie (which holds the PKCE verifier) a replayed state is
// useless. The provider additionally enforces auth-code single-use.

function stateSecret(): string {
  return process.env.SESSION_SECRET ?? 'dev-state-secret';
}

export function signOAuthState(userId: string, now: number = Date.now()): string {
  const nonce = randomBytes(12).toString('base64url');
  const exp = String(now + STATE_TTL_MS);
  const mac = createHmac('sha256', stateSecret())
    .update(`claude-oauth:${userId}:${exp}:${nonce}`)
    .digest('base64url');
  return `${exp}.${nonce}.${mac}`;
}

export function verifyOAuthState(state: string, userId: string, now: number = Date.now()): boolean {
  const [exp, nonce, mac] = state.split('.');
  if (!exp || !nonce || !mac) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = createHmac('sha256', stateSecret())
    .update(`claude-oauth:${userId}:${exp}:${nonce}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── PKCE cookie payload (encrypted; never readable by the browser JS) ───────

export const PKCE_COOKIE = 'rc_claude_oauth';

export function encodePkceCookie(payload: { state: string; verifier: string; userId: string }): string {
  return encryptApiKey(JSON.stringify(payload));
}

export function decodePkceCookie(raw: string): { state: string; verifier: string; userId: string } | null {
  try {
    const parsed = JSON.parse(decryptApiKey(raw)) as { state?: unknown; verifier?: unknown; userId?: unknown };
    if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string' || typeof parsed.userId !== 'string') {
      return null;
    }
    return { state: parsed.state, verifier: parsed.verifier, userId: parsed.userId };
  } catch {
    return null;
  }
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(params: {
  config: ClaudeOAuthConfig;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(params.config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.config.scopes) url.searchParams.set('scope', params.config.scopes);
  return url.toString();
}

// ── Token exchange / refresh (standard OAuth 2.0 grants) ────────────────────

export type ClaudeTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: Date | null;
};

class ClaudeOAuthError extends Error {
  constructor(public userMessage: string, detail: string) {
    super(detail);
    this.name = 'ClaudeOAuthError';
  }
}

function parseTokenResponse(json: Record<string, unknown>, now: number): ClaudeTokens {
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new ClaudeOAuthError(
      'Die Verbindung mit Claude ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
      'token response without access_token',
    );
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : null,
    expiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
  };
}

async function tokenGrant(
  config: ClaudeOAuthConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: number,
): Promise<ClaudeTokens> {
  body.set('client_id', config.clientId);
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  let res: Response;
  try {
    res = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ClaudeOAuthError(
      'Claude ist gerade nicht erreichbar. Bitte versuchen Sie es in ein paar Minuten erneut.',
      'token endpoint unreachable',
    );
  }
  if (!res.ok) {
    // Never log or surface the response body wholesale — it may echo inputs.
    throw new ClaudeOAuthError(
      res.status === 400 || res.status === 401
        ? 'Claude hat die Verbindung abgelehnt. Bitte starten Sie die Anmeldung neu.'
        : 'Die Verbindung mit Claude ist momentan gestört. Bitte später erneut versuchen.',
      `token endpoint HTTP ${res.status}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return parseTokenResponse(json, now);
}

export async function exchangeCode(params: {
  config: ClaudeOAuthConfig;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ClaudeTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });
  return tokenGrant(params.config, body, params.fetchImpl ?? fetch, params.now ?? Date.now());
}

export async function refreshAccessToken(params: {
  config: ClaudeOAuthConfig;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<ClaudeTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  });
  return tokenGrant(params.config, body, params.fetchImpl ?? fetch, params.now ?? Date.now());
}

// ── Storage ──────────────────────────────────────────────────────────────────

export async function storeConnection(userId: string, tokens: ClaudeTokens): Promise<void> {
  const data = {
    encryptedAccessToken: encryptApiKey(tokens.accessToken),
    encryptedRefreshToken: tokens.refreshToken ? encryptApiKey(tokens.refreshToken) : null,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    lastError: null,
  };
  await db.userClaudeOAuth.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data, lastRefreshAt: new Date() },
  });
}

export type ClaudeConnectionView = {
  connected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  scope: string | null;
  lastError: string | null;
};

export async function getConnectionView(userId: string): Promise<ClaudeConnectionView> {
  const row = await db.userClaudeOAuth.findUnique({ where: { userId } });
  return {
    connected: !!row,
    connectedAt: row?.connectedAt?.toISOString() ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    scope: row?.scope ?? null,
    lastError: row?.lastError ?? null,
  };
}

export async function disconnect(userId: string): Promise<void> {
  await db.userClaudeOAuth.deleteMany({ where: { userId } });
}

/**
 * Refresh the stored connection if it is expired/near expiry and a refresh
 * token exists. Returns a German user message on failure (also persisted to
 * lastError) or null on success/no-op. Runtime AEGIS use of the token stays
 * out of scope until activation (see module docblock).
 */
export async function ensureFreshConnection(
  userId: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<string | null> {
  const config = claudeOAuthConfig();
  if (!config) return SETUP_REQUIRED_MESSAGE;
  const row = await db.userClaudeOAuth.findUnique({ where: { userId } });
  if (!row) return 'Keine Claude-Verbindung vorhanden.';
  const skewMs = 60_000;
  if (!row.expiresAt || row.expiresAt.getTime() - skewMs > now) return null; // still fresh
  if (!row.encryptedRefreshToken) {
    const msg = 'Ihre Claude-Verbindung ist abgelaufen. Bitte unter Konto → AI-Provider neu verbinden.';
    await db.userClaudeOAuth.update({ where: { userId }, data: { lastError: msg } });
    return msg;
  }
  try {
    const refreshToken = decryptApiKey(row.encryptedRefreshToken);
    const tokens = await refreshAccessToken({ config, refreshToken, fetchImpl, now });
    await storeConnection(userId, {
      ...tokens,
      // Providers may rotate or omit the refresh token on refresh; keep the old
      // one when none is returned.
      refreshToken: tokens.refreshToken ?? refreshToken,
    });
    return null;
  } catch (err) {
    const msg =
      err instanceof ClaudeOAuthError
        ? `${err.userMessage}`
        : 'Ihre Claude-Verbindung konnte nicht erneuert werden. Bitte unter Konto → AI-Provider neu verbinden.';
    await db.userClaudeOAuth.update({ where: { userId }, data: { lastError: msg } });
    return msg;
  }
}
