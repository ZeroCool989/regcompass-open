import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Service-to-service auth for the voice gateway (Phase 4). The gateway reaches
 * /api/aegis with `Authorization: Bearer <AEGIS_SERVICE_TOKEN>` and, when the
 * token is valid, supplies a conversation session id via `X-Aegis-Session` so
 * voice turns get conversation memory WITHOUT a browser cookie.
 *
 * Guarantees:
 *  - Separate secret (`AEGIS_SERVICE_TOKEN`), distinct from `SESSION_SECRET`.
 *  - Constant-time compare that does NOT leak token length: both sides are
 *    SHA-256'd to fixed-length digests before `timingSafeEqual`.
 *  - Namespaced session ids: a gateway id is forced into the `voice:` namespace
 *    AEGIS-side and the supplied part may not contain `:`, so a voice session
 *    can never collide with or read a browser rc_session's memory (bare UUIDs).
 *  - No-token requests are unaffected (public/cookie path); a present-but-invalid
 *    token resolves to `invalid` → the route returns 401 (no silent downgrade).
 *  - The token is never logged.
 */

export type ServiceAuth =
  | { kind: 'none' }
  | { kind: 'valid'; sessionId: string }
  | { kind: 'invalid'; reason: string };

/** Voice session namespace — keeps these ids disjoint from bare-UUID cookies. */
export const VOICE_SESSION_PREFIX = 'voice:';

// Supplied id: no `:` (can't escape the namespace), bounded length, safe charset.
const SESSION_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Length-agnostic constant-time comparison: hash both inputs to 32-byte digests
 * first, so `timingSafeEqual` always runs on equal-length buffers and the
 * presented token's length is not observable as a side channel.
 */
function tokensMatch(presented: string, secret: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export function resolveServiceAuth(req: NextRequest): ServiceAuth {
  const header = req.headers.get('authorization');
  if (!header) return { kind: 'none' }; // public / cookie path — unchanged

  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return { kind: 'invalid', reason: 'malformed_authorization' };
  const presented = match[1];

  const secret = process.env.AEGIS_SERVICE_TOKEN;
  // Fail-closed: a token was presented but the service path has no secret to
  // validate it against — never accept.
  if (!secret) return { kind: 'invalid', reason: 'service_auth_unconfigured' };

  if (!tokensMatch(presented, secret)) return { kind: 'invalid', reason: 'bad_token' };

  const supplied = req.headers.get('x-aegis-session') ?? '';
  if (!SESSION_ID_RE.test(supplied)) return { kind: 'invalid', reason: 'bad_session_id' };

  return { kind: 'valid', sessionId: `${VOICE_SESSION_PREFIX}${supplied}` };
}
