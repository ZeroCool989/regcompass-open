import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { createEmailVerifyToken, hashPassword, isAllowlisted, isDeployedEnv } from '@/lib/auth';
import { db } from '@/lib/db';
import { sendVerificationEmail } from '@/lib/email';

/**
 * Self-service signup (D7). Creates a PENDING account with an unverified email
 * and sends a verification link. Login stays impossible until the email is
 * verified (lib/auth: canAuthenticate) AND an admin approves the account.
 *
 * Anti-enumeration: the response for a well-formed submission is ALWAYS the
 * same generic body — whether the email is new, already registered, or
 * allowlisted. Only USERNAME conflicts get a specific error: usernames are
 * public display names, and the conflict reveals nothing about which email
 * addresses have accounts.
 */

const limiter = rateLimit({ key: 'auth-register', limit: 5, windowMs: 15 * 60 * 1000 });

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,38}[\p{L}\p{N}]$/u;

const GENERIC = {
  ok: true,
  message:
    'Falls diese E-Mail-Adresse noch nicht registriert ist, wurde ein Bestätigungslink gesendet. Bitte prüfen Sie Ihr Postfach.',
} as const;

export async function POST(req: NextRequest) {
  if (!(await limiter.check(ipHash(req))).ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Versuche. Bitte später erneut.' },
      { status: 429, headers: { 'Retry-After': '900' } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Ungültige Anfrage.' }, { status: 400 });
  }
  const email = String((body as { email?: unknown })?.email ?? '').trim().toLowerCase();
  const username = String((body as { username?: unknown })?.username ?? '').trim();
  const password = String((body as { password?: unknown })?.password ?? '');

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Bitte geben Sie eine gültige E-Mail-Adresse an.' },
      { status: 400 },
    );
  }
  if (!USERNAME_RE.test(username)) {
    return NextResponse.json(
      {
        error: 'invalid_input',
        message: 'Der Anzeigename muss 3–40 Zeichen lang sein (Buchstaben, Zahlen, Leerzeichen, ., _, -).',
      },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: 'weak_password', message: `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.` },
      { status: 400 },
    );
  }

  // Username conflicts are reported specifically (public display names — no
  // email-existence signal). Checked before the email branch so the taken-name
  // answer is identical whether or not the email already has an account.
  const nameTaken = await db.user.findUnique({ where: { username }, select: { id: true, email: true } });
  if (nameTaken && nameTaken.email !== email) {
    return NextResponse.json(
      { error: 'username_taken', message: 'Dieser Anzeigename ist bereits vergeben.' },
      { status: 409 },
    );
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (!existing) {
    const user = await db.user.create({
      data: {
        email,
        username,
        passwordHash: hashPassword(password),
        // status defaults to PENDING; emailVerifiedAt stays null until the link
        // is clicked. Both gates (verify + admin approval) must pass for AEGIS.
      },
    });

    if (!process.env.APP_BASE_URL && isDeployedEnv()) {
      // Same SEC-1 stance as the reset flow: never build emailed links from a
      // request-derived host in deployed envs.
      throw new Error(
        'APP_BASE_URL must be set in deployed environments — refusing to build a verification link from the request origin.',
      );
    }
    const base = process.env.APP_BASE_URL || req.nextUrl.origin;
    const token = createEmailVerifyToken(email, user.passwordHash);
    const verifyUrl = `${base}/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await sendVerificationEmail(email, verifyUrl);
    } catch (err) {
      // Delivery failure must not change the response shape (no leak, no 500).
      // The user can re-register after the rate window; the row already exists,
      // so the retry lands in the "existing" branch and re-sends below.
      console.warn(
        JSON.stringify({
          event: 'verification_email_failed',
          level: 'warn',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  } else if (!existing.emailVerifiedAt && !isAllowlisted(email) && existing.status === 'PENDING') {
    // Unverified self-registration, re-submitted: re-send the link (fresh
    // token), same generic response. Password/username of the existing row are
    // NOT overwritten — an attacker must not be able to reset someone's pending
    // signup. Seeded/allowlisted or already-processed accounts are excluded so
    // third parties can't trigger mails to their owners.
    const base = process.env.APP_BASE_URL || req.nextUrl.origin;
    const token = createEmailVerifyToken(email, existing.passwordHash);
    const verifyUrl = `${base}/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await sendVerificationEmail(email, verifyUrl);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'verification_email_failed',
          level: 'warn',
          message: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }
  }
  // Verified or allowlisted existing account: silently do nothing (GENERIC).

  return NextResponse.json(GENERIC);
}
