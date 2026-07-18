import type { OAuthConfig } from './core';

/**
 * Subscription providers that can back AEGIS when connected via OAuth.
 *
 * Every provider requires an OAuth client registered by the operator with that
 * provider (client_id, and for some the token endpoint). None is hardcoded:
 * each is read from env. When a provider's client_id is unset, its status is
 * `unconfigured` and the UI shows an honest "Setup erforderlich" state instead
 * of a broken button. See docs/OAUTH_SETUP.md for the per-provider steps.
 *
 * The provider families map onto the model backends in providers/catalog.ts:
 *   anthropic → AnthropicProvider, openai → OpenAI-compatible, google → Gemini.
 */

export type OAuthProviderId = 'anthropic' | 'openai' | 'google';

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = ['anthropic', 'openai', 'google'];

export type OAuthProviderMeta = {
  id: OAuthProviderId;
  label: string;
  /** Human hint shown in the Setup-erforderlich state. */
  setupHint: string;
  /** Extra authorize-endpoint params some providers require (e.g. access_type). */
  authorizeExtra?: Record<string, string>;
};

export const OAUTH_PROVIDER_META: Record<OAuthProviderId, OAuthProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic-Abo)',
    setupHint:
      'OAuth-Client bei Anthropic registrieren und ANTHROPIC_OAUTH_CLIENT_ID / ANTHROPIC_OAUTH_TOKEN_URL setzen.',
  },
  openai: {
    id: 'openai',
    label: 'ChatGPT (OpenAI-Abo)',
    setupHint: 'OAuth-Client bei OpenAI registrieren und OPENAI_OAUTH_CLIENT_ID setzen.',
  },
  google: {
    id: 'google',
    label: 'Gemini (Google-Abo)',
    setupHint:
      'OAuth-Client in der Google Cloud Console anlegen und GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET setzen.',
    authorizeExtra: { access_type: 'offline', prompt: 'consent' },
  },
};

/** Public, fixed endpoints. Providers whose endpoints are not public are read
 *  entirely from env and stay `unconfigured` until the operator sets them. */
const DEFAULTS: Record<OAuthProviderId, { authorizeUrl?: string; tokenUrl?: string; scopes?: string }> = {
  anthropic: {
    // Token URL intentionally has no default — it is issued with the client.
    scopes: undefined,
  },
  openai: {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: 'openid profile email offline_access',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/generative-language.retriever',
  },
};

const ENV_PREFIX: Record<OAuthProviderId, string> = {
  anthropic: 'ANTHROPIC_OAUTH',
  openai: 'OPENAI_OAUTH',
  google: 'GOOGLE_OAUTH',
};

function pick(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Resolve a provider's OAuth config from env, or null when it is not
 * registered yet (no client_id, or no token endpoint available). Endpoints not
 * carrying a public default MUST be supplied via env.
 */
export function oauthConfig(
  id: OAuthProviderId,
  env: Record<string, string | undefined> = process.env,
): OAuthConfig | null {
  const p = ENV_PREFIX[id];
  const d = DEFAULTS[id];
  const clientId = pick(env, `${p}_CLIENT_ID`);
  const tokenUrl = pick(env, `${p}_TOKEN_URL`) ?? d.tokenUrl;
  const authorizeUrl = pick(env, `${p}_AUTHORIZE_URL`) ?? d.authorizeUrl;
  if (!clientId || !tokenUrl || !authorizeUrl) return null;
  return {
    clientId,
    clientSecret: pick(env, `${p}_CLIENT_SECRET`) ?? null,
    authorizeUrl,
    tokenUrl,
    scopes: pick(env, `${p}_SCOPES`) ?? d.scopes ?? null,
  };
}

export function isConfigured(id: OAuthProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  return oauthConfig(id, env) !== null;
}

export function parseProviderId(value: string | undefined | null): OAuthProviderId | null {
  return value && (OAUTH_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as OAuthProviderId)
    : null;
}
