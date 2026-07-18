import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import {
  hashPassword,
  isAllowlisted,
  peekResetTokenEmail,
  verifyResetToken,
} from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Complete a password reset: verify the hash-bound, unexpired token against the
 * account's CURRENT password hash, then set the new password with the existing
 * scrypt hasher. Because the token is bound to the old hash, this single update
 * invalidates the link (and any copy of it) automatically.
 */

const limiter = rateLimit({ key: 'auth-reset', limit: 20, windowMs: 60 * 60 * 1000 });
const MIN_PASSWORD = 8;

export async function POST(req: NextRequest) {
  if (!(await limiter.check(ipHash(req))).ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Versuche. Bitte später erneut.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Ungültige Anfrage.' }, { status: 400 });
  }
  const token = String((body as { token?: unknown })?.token ?? '');
  const password = String((body as { password?: unknown })?.password ?? '');

  const invalid = NextResponse.json(
    { error: 'invalid_token', message: 'Der Link ist ungültig oder abgelaufen.' },
    { status: 400 },
  );

  // Email is read (unverified) only to load the account; verifyResetToken then
  // authenticates the token against that account's current password hash.
  const peeked = peekResetTokenEmail(token);
  const user = peeked ? await db.user.findUnique({ where: { email: peeked } }) : null;
  const email = user ? verifyResetToken(token, user.passwordHash) : null;
  if (!email || !isAllowlisted(email)) return invalid;

  if (password.length < MIN_PASSWORD) {
    return NextResponse.json(
      { error: 'weak_password', message: `Das Passwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.` },
      { status: 400 },
    );
  }

  await db.user.update({
    where: { email },
    data: { passwordHash: hashPassword(password) },
  });

  return NextResponse.json({ ok: true });
}
