import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standards-based OAuth 2.0 primitives for connecting a subscription from the
 * local app: Authorization Code + PKCE (RFC 7636, S256) over a loopback
 * redirect (RFC 8252) — the app serves its own callback on localhost, so no
 * separate callback server is needed. Provider-agnostic: every function takes
 * an {@link OAuthConfig}, so the same code drives Claude, ChatGPT and Gemini.
 */

export type OAuthConfig = {
  clientId: string;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string | null;
};

const STATE_TTL_MS = 10 * 60 * 1000;

// ── PKCE (RFC 7636, S256) ────────────────────────────────────────────────────

export function generatePkceVerifier(): string {
  return randomBytes(48).toString('base64url'); // 64 chars, within the 43–128 range
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── State: HMAC-bound, expiring, tamper-evident ─────────────────────────────
// Single-use is enforced by the paired httpOnly cookie holding the verifier:
// the callback clears it, and a replayed state without the cookie is useless.
// The provider additionally enforces authorization-code single-use.

function stateSecret(): string {
  return process.env.SESSION_SECRET ?? 'dev-state-secret';
}

export function signOAuthState(providerId: string, userId: string, now: number = Date.now()): string {
  const nonce = randomBytes(12).toString('base64url');
  const exp = String(now + STATE_TTL_MS);
  const mac = createHmac('sha256', stateSecret())
    .update(`${providerId}:${userId}:${exp}:${nonce}`)
    .digest('base64url');
  return `${exp}.${nonce}.${mac}`;
}

export function verifyOAuthState(
  state: string,
  providerId: string,
  userId: string,
  now: number = Date.now(),
): boolean {
  const [exp, nonce, mac] = state.split('.');
  if (!exp || !nonce || !mac) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = createHmac('sha256', stateSecret())
    .update(`${providerId}:${userId}:${exp}:${nonce}`)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(params: {
  config: OAuthConfig;
  redirectUri: string;
  state: string;
  challenge: string;
  extra?: Record<string, string>;
}): string {
  const url = new URL(params.config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.config.scopes) url.searchParams.set('scope', params.config.scopes);
  for (const [k, v] of Object.entries(params.extra ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

// ── Token exchange / refresh (standard OAuth 2.0 grants) ────────────────────

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: Date | null;
};

export class OAuthFlowError extends Error {
  constructor(
    public userMessage: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'OAuthFlowError';
  }
}

function parseTokenResponse(json: Record<string, unknown>, now: number): OAuthTokens {
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new OAuthFlowError(
      'Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
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
  config: OAuthConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: number,
): Promise<OAuthTokens> {
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
    throw new OAuthFlowError(
      'Der Anbieter ist gerade nicht erreichbar. Bitte versuchen Sie es in ein paar Minuten erneut.',
      'token endpoint unreachable',
    );
  }
  if (!res.ok) {
    // Never surface the response body wholesale — it can echo the request.
    throw new OAuthFlowError(
      res.status === 400 || res.status === 401
        ? 'Der Anbieter hat die Verbindung abgelehnt. Bitte starten Sie die Anmeldung neu.'
        : 'Die Verbindung ist momentan gestört. Bitte später erneut versuchen.',
      `token endpoint HTTP ${res.status}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return parseTokenResponse(json, now);
}

export async function exchangeCode(params: {
  config: OAuthConfig;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });
  return tokenGrant(params.config, body, params.fetchImpl ?? fetch, params.now ?? Date.now());
}

export async function refreshAccessToken(params: {
  config: OAuthConfig;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  });
  return tokenGrant(params.config, body, params.fetchImpl ?? fetch, params.now ?? Date.now());
}
