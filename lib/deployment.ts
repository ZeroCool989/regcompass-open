/**
 * Centralized deployment / environment detection — the single source of truth.
 *
 * RegCompass ships as a downloadable, local-first single-user app AND can be
 * hosted for a team. `next start` runs with `NODE_ENV=production` even on a
 * laptop, so **NODE_ENV must never be used as evidence of a hosted deployment** —
 * a local production build is still local. Hosting is proven only by an explicit
 * platform signal, and HTTPS only by a validated public URL / platform.
 *
 * This replaces the five previously-duplicated `deployed()` / `isDeployedEnv()`
 * helpers (proxy.ts, lib/session.ts, lib/auth.ts, lib/aegis/provider-settings.ts,
 * lib/regulatory/cron-auth.ts). It is **edge-runtime safe** — only `process.env`
 * and string parsing, no `node:crypto` — so `proxy.ts` can import it directly.
 */

export type Env = Record<string, string | undefined>;

/**
 * Strict boolean env parse. Only an explicit truthy token counts as true; the
 * strings "false", "0", "no", "off", "", and an unset var are all false. This
 * prevents the classic `Boolean("false") === true` footgun where any non-empty
 * value (including "false") reads as truthy.
 */
export function envFlag(name: string, env: Env = process.env): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Is this a genuinely HOSTED deployment (not merely a local production build)?
 * True only for a verified platform signal:
 *  - Vercel (`VERCEL=1`, or `VERCEL_ENV` = production/preview), or
 *  - explicit operator opt-in `REGCOMPASS_HOSTED=1`.
 * `NODE_ENV` is deliberately ignored.
 */
export function isHostedDeployment(env: Env = process.env): boolean {
  return (
    envFlag('REGCOMPASS_HOSTED', env) ||
    envFlag('VERCEL', env) ||
    env.VERCEL_ENV === 'production' ||
    env.VERCEL_ENV === 'preview'
  );
}

/**
 * Does this deployment actually serve over HTTPS on a validated public URL?
 * Drives Secure cookies and HSTS — based on real transport config, never
 * `NODE_ENV`:
 *  - an explicit `https://` public base URL (`APP_BASE_URL` / `REGCOMPASS_PUBLIC_URL`), or
 *  - a hosted platform that terminates TLS for us (Vercel).
 * A local http build (localhost or LAN) is never HTTPS.
 */
export function usesHttps(env: Env = process.env): boolean {
  const base = (env.APP_BASE_URL ?? env.REGCOMPASS_PUBLIC_URL)?.trim();
  if (base && /^https:\/\//i.test(base)) return true;
  if (envFlag('VERCEL', env) || env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview') return true;
  return false;
}

/**
 * Must the app's real secrets (SESSION_SECRET, AEGIS_BYOK_ENCRYPTION_KEY) be
 * set, or may the local insecure dev fallback be used? Real secrets are required
 * only for a hosted deployment — a local build (even a production `next start`)
 * may use the fallback so a downloadable install never crashes on first run.
 */
export function requiresRealSecrets(env: Env = process.env): boolean {
  return isHostedDeployment(env);
}

/** Mark cookies `Secure` only when actually served over HTTPS. */
export function cookiesSecure(env: Env = process.env): boolean {
  return usesHttps(env);
}

/** Send HSTS only for a confirmed HTTPS deployment — never for local http. */
export function hstsEnabled(env: Env = process.env): boolean {
  return usesHttps(env);
}

// ───────────────────────────── Network binding guard ─────────────────────────────

/** Hosts that mean "this machine only" — not reachable from the local network. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** The interface the launcher binds to. Loopback by default. */
export function configuredBindHost(env: Env = process.env): string {
  return env.REGCOMPASS_HOST?.trim() || '127.0.0.1';
}

/** AUTH_MODE, defaulting to 'local' (single implicit admin, no login). */
export function authModeOf(env: Env = process.env): 'local' | 'multi' {
  return env.AUTH_MODE?.trim().toLowerCase() === 'multi' ? 'multi' : 'local';
}

/** Thrown when a non-loopback bind would expose the unauthenticated local admin. */
export class BindingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingRefusedError';
  }
}

/**
 * The single, centralized binding rule (bin/regcompass-open, scripts/start.ts,
 * and both installers all enforce THIS). Loopback binds are always allowed. A
 * non-loopback bind exposes RegCompass to the network and is REFUSED (not merely
 * warned) unless a real authenticated mode is configured (`AUTH_MODE=multi`) —
 * because the default local mode has an implicit admin and no login. There is no
 * bypass. Returns the validated host, or throws {@link BindingRefusedError}.
 */
export function assertBindingAllowed(env: Env = process.env): string {
  const host = configuredBindHost(env);
  if (isLoopbackHost(host)) return host;
  if (authModeOf(env) !== 'multi') {
    throw new BindingRefusedError(
      `Refusing to start: REGCOMPASS_HOST=${host} would expose RegCompass to the network, ` +
        `but AUTH_MODE is "local" — there is no login and the single user is an admin, so ` +
        `anyone on the network could use it as you. Set AUTH_MODE=multi with real accounts ` +
        `before binding to a non-loopback address, or keep the default loopback (127.0.0.1).`,
    );
  }
  return host;
}
