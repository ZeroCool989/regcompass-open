import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { cookiesSecure, requiresRealSecrets } from '@/lib/deployment';

/**
 * Anonymous browser sessions, used to scope uploaded documents (and any other
 * per-visitor state) without full authentication. The cookie value is
 * `<uuid>.<hmac-sha256-hex>`; the HMAC prevents clients from minting or
 * tampering with session ids.
 *
 * The cookie is normally issued by `proxy.ts` (edge runtime, Web Crypto —
 * the signing scheme there must stay byte-identical to this one). Routes that
 * can be hit before any page load (e.g. direct API calls) fall back to
 * `createSession()` and set the cookie on their own response.
 */

export const SESSION_COOKIE = 'rc_session';

// Used when SESSION_SECRET is missing so local dev works out of the box.
// Sessions signed with it are NOT secure — a deployed env must set the env var.
const FALLBACK_SECRET = 'rc-dev-insecure-session-secret';

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (requiresRealSecrets()) {
    throw new Error(
      'SESSION_SECRET is unset or shorter than 16 chars in a hosted deployment — ' +
        'refusing to sign sessions with the insecure dev fallback.',
    );
  }
  return FALLBACK_SECRET;
}

function sign(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('hex');
}

export function createSession(): { id: string; value: string } {
  const id = randomUUID();
  return { id, value: `${id}.${sign(id)}` };
}

/** Returns the session id if the cookie value carries a valid signature. */
export function verifySessionValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = sign(id);
  if (mac.length !== expected.length) return null;
  try {
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? id : null;
  } catch {
    return null;
  }
}

export function readSessionId(req: NextRequest): string | null {
  return verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookiesSecure(),
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}
