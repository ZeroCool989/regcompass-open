import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { peekEmailVerifyTokenEmail, verifyEmailVerifyToken } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Complete email verification (D7): validate the hash-bound token and stamp
 * `emailVerifiedAt`. Idempotent — clicking the link twice is fine. One generic
 * error for every invalid-token flavour (bad MAC, expired, unknown email) so
 * the endpoint is no oracle for account existence.
 */

const limiter = rateLimit({ key: 'auth-verify', limit: 20, windowMs: 15 * 60 * 1000 });

const INVALID = {
  error: 'invalid_token',
  message: 'Dieser Bestätigungslink ist ungültig oder abgelaufen. Bitte registrieren Sie sich erneut, um einen neuen Link zu erhalten.',
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
  const token = String((body as { token?: unknown })?.token ?? '');

  const email = peekEmailVerifyTokenEmail(token);
  const user = email ? await db.user.findUnique({ where: { email } }) : null;
  const verified = user ? verifyEmailVerifyToken(token, user.passwordHash) : null;
  if (!user || !verified) {
    return NextResponse.json(INVALID, { status: 400 });
  }

  if (!user.emailVerifiedAt) {
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }

  return NextResponse.json({
    ok: true,
    message:
      'E-Mail-Adresse bestätigt. Ihr Konto muss nun von einem Administrator freigegeben werden — Sie können sich bereits anmelden und sehen dort den Status.',
  });
}
