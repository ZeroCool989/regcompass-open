import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import type { User } from '@/app/generated/prisma/client';

/**
 * Email + password auth for RegCompass. Gates AEGIS so only approved users can
 * spend Claude API tokens. A new signup is PENDING until an admin approves it;
 * emails listed in ADMIN_EMAILS are auto-approved admins.
 *
 * Design: the auth cookie is a stateless HMAC-signed token carrying the user
 * id (`<id>.<hmac>`), signed with SESSION_SECRET but domain-separated from the
 * anonymous `rc_session` cookie by an "auth:" payload prefix. The user's status
 * is read live from the DB on every guarded request, so un-approving or
 * blocking a user takes effect immediately (no session to revoke).
 */

export const AUTH_COOKIE = 'rc_auth';

// Mirror lib/session.ts so dev works without a secret but a deployed env fails
// loud rather than signing auth tokens with the insecure fallback.
const FALLBACK_SECRET = 'rc-dev-insecure-session-secret';

export function isDeployedEnv(): boolean {
  const v = process.env.VERCEL_ENV;
  return v === 'production' || v === 'preview' || process.env.NODE_ENV === 'production';
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (isDeployedEnv()) {
    throw new Error(
      'SESSION_SECRET is unset or shorter than 16 chars in a deployed environment — ' +
        'refusing to sign auth tokens with the insecure dev fallback.',
    );
  }
  return FALLBACK_SECRET;
}

function sign(userId: string): string {
  return createHmac('sha256', secret()).update(`auth:${userId}`).digest('hex');
}

// ─────────────────────────── Passwords (scrypt) ───────────────────────────

const SCRYPT_KEYLEN = 64;

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. No external dependency. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const dk = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${dk}`;
}

/** Constant-time verify of a password against a stored `scrypt$salt$hash`. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length || SCRYPT_KEYLEN);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * A throwaway hash of a random secret, generated once at module load. The login
 * route verifies against this when no account matches the submitted email, so an
 * unknown email costs the same scrypt work as a known one — closing the timing
 * side-channel that would otherwise let an attacker enumerate registered users.
 */
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));

// ─────────────────────────── Auth cookie ───────────────────────────

export function authCookieValue(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** Returns the user id if the cookie value carries a valid signature. */
export function verifyAuthValue(value: string | null | undefined): string | null {
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

// ─────────────────────────── Password-reset tokens (stateless, hash-bound) ───────────────────────────
// A signed, self-expiring token — no DB row, no email provider required. The
// visible payload is `<email>|<expiryMs>`; the HMAC (SESSION_SECRET, `reset:`
// domain-separated) is taken over the payload AND the account's CURRENT
// passwordHash. That binding makes the token self-invalidating: the moment the
// password is reset the hash changes, so the link (and any copy of it) stops
// verifying — giving invalidate-on-reset and effective single-use-after-use,
// with no server state. Validity is additionally bounded by the TTL.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** HMAC over the payload bound to the account's current password hash. */
function resetMac(payload: string, passwordHash: string): string {
  return createHmac('sha256', secret()).update(`reset:${payload}|${passwordHash}`).digest('hex');
}

/**
 * Mint a reset token bound to `passwordHash` (the account's current hash). Once
 * the password changes this token no longer verifies.
 */
export function createResetToken(
  email: string,
  passwordHash: string,
  ttlMs = RESET_TOKEN_TTL_MS,
): string {
  const exp = Date.now() + ttlMs;
  const payload = `${email.trim().toLowerCase()}|${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${resetMac(payload, passwordHash)}`;
}

function decodeResetPayload(
  token: string | null | undefined,
): { email: string; exp: number; mac: string; payload: string } | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const mac = token.slice(dot + 1);
  const sep = payload.lastIndexOf('|');
  if (sep <= 0) return null;
  const email = payload.slice(0, sep).toLowerCase();
  const exp = Number(payload.slice(sep + 1));
  if (!Number.isFinite(exp)) return null;
  return { email, exp, mac, payload };
}

/**
 * The email embedded in the token — UNVERIFIED, for looking up the account only.
 * Always follow with verifyResetToken() against that account's password hash.
 */
export function peekResetTokenEmail(token: string | null | undefined): string | null {
  return decodeResetPayload(token)?.email ?? null;
}

/**
 * Verify the token's signature (bound to `currentPasswordHash`) and expiry.
 * Returns the email if valid, else null. Pure — the caller supplies the hash.
 */
export function verifyResetToken(
  token: string | null | undefined,
  currentPasswordHash: string,
): string | null {
  const d = decodeResetPayload(token);
  if (!d) return null;
  const expected = resetMac(d.payload, currentPasswordHash);
  if (d.mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(d.mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  if (Date.now() > d.exp) return null;
  return d.email;
}

// ─────────────────────────── Email-verification tokens (stateless, hash-bound) ───────────────────────────
// Same construction as reset tokens, domain-separated with `verify:` so the two
// token families can never be replayed against each other. Bound to the
// account's passwordHash: a password change (or reset) invalidates outstanding
// verification links. Verification only flips `emailVerifiedAt`, so strict
// single-use is not security-relevant — idempotent re-verification is harmless.

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function verifyMac(payload: string, passwordHash: string): string {
  return createHmac('sha256', secret()).update(`verify:${payload}|${passwordHash}`).digest('hex');
}

export function createEmailVerifyToken(
  email: string,
  passwordHash: string,
  ttlMs = VERIFY_TOKEN_TTL_MS,
): string {
  const exp = Date.now() + ttlMs;
  const payload = `${email.trim().toLowerCase()}|${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${verifyMac(payload, passwordHash)}`;
}

/** The email embedded in the token — UNVERIFIED, for account lookup only. */
export function peekEmailVerifyTokenEmail(token: string | null | undefined): string | null {
  return decodeResetPayload(token)?.email ?? null;
}

/** Verify signature (bound to `currentPasswordHash`) and expiry → email or null. */
export function verifyEmailVerifyToken(
  token: string | null | undefined,
  currentPasswordHash: string,
): string | null {
  const d = decodeResetPayload(token);
  if (!d) return null;
  const expected = verifyMac(d.payload, currentPasswordHash);
  if (d.mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(d.mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  if (Date.now() > d.exp) return null;
  return d.email;
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  };
}

// ─────────────────────────── User lookup / status ───────────────────────────

export function isApproved(user: Pick<User, 'status'> | null): boolean {
  return !!user && user.status === 'APPROVED';
}

/**
 * The one admin gate for API routes and pages: admin role AND approved
 * status. Blocking or un-approving an admin must revoke their admin powers
 * immediately (SEC-2) — role alone is NOT sufficient. `isAdminEmail` is
 * consulted as role source of truth for the admin email allowlist, but the
 * live DB status always gates.
 */
export function requireAdmin<T extends Pick<User, 'email' | 'role' | 'status'>>(
  user: T | null,
): user is T {
  if (!user) return false;
  if (!isApproved(user)) return false;
  return user.role === 'ADMIN' || isAdminEmail(user.email);
}

/** Load the user behind a (verified) auth-cookie value, or null. */
export async function userFromCookieValue(
  value: string | null | undefined,
): Promise<User | null> {
  const id = verifyAuthValue(value);
  if (!id) return null;
  return db.user.findUnique({ where: { id } });
}

/** Current user from a route-handler request (NextRequest), or null. */
export async function getUserFromRequest(req: NextRequest): Promise<User | null> {
  return userFromCookieValue(req.cookies.get(AUTH_COOKIE)?.value);
}

/** Current user in a Server Component / page (reads next/headers cookies), or null. */
export async function getUserFromCookies(): Promise<User | null> {
  const store = await cookies();
  return userFromCookieValue(store.get(AUTH_COOKIE)?.value);
}

// ─────────────────────────── Admin bootstrap ───────────────────────────

/** Lowercased admin email allowlist from ADMIN_EMAILS (comma/space separated). */
export function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().has(email.trim().toLowerCase());
}

// ─────────────────────────── Login allowlist ───────────────────────────

/**
 * Lowercased login allowlist from AUTH_ALLOWLIST (comma/space separated).
 * OPTIONAL in this build: when empty (the default), registration is open to
 * anyone who can reach the instance; when set, only listed emails may register.
 * Distinct from ADMIN_EMAILS, which only grants the admin role.
 */
export function allowlistEmails(): Set<string> {
  return new Set(
    (process.env.AUTH_ALLOWLIST ?? '')
      .split(/[,\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowlisted(email: string): boolean {
  return allowlistEmails().has(email.trim().toLowerCase());
}

/**
 * May this account authenticate at all? Two entry paths:
 *  - allowlisted, or
 *  - a completed registration (`emailVerifiedAt` is stamped at signup — this
 *    build runs offline, so there is no email round-trip to wait for).
 * BLOCKED is checked separately by callers; this only answers "is the account
 * eligible to log in". Rows missing the stamp fail closed.
 */
export function canAuthenticate(
  user: (Pick<User, 'email'> & { emailVerifiedAt?: Date | null }) | null,
): boolean {
  if (!user) return false;
  // Loose != so a row missing the field (undefined) counts as UNVERIFIED —
  // fail closed rather than open.
  return isAllowlisted(user.email) || user.emailVerifiedAt != null;
}
