import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import {
  AUTH_COOKIE,
  authCookieOptions,
  authCookieValue,
  authMode,
  canAuthenticate,
  DUMMY_PASSWORD_HASH,
  isAdminEmail,
  verifyPassword,
} from '@/lib/auth';
import { db } from '@/lib/db';

const limiter = rateLimit({ key: 'auth-login', limit: 30, windowMs: 60 * 60 * 1000 });

export async function POST(req: NextRequest) {
  if (authMode() === 'local') {
    return NextResponse.json(
      { error: 'auth_disabled', message: 'Diese Installation läuft ohne Konten — eine Anmeldung ist nicht nötig.' },
      { status: 404 },
    );
  }
  const limit = await limiter.check(ipHash(req));
  if (!limit.ok) {
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
  const email = String((body as { email?: unknown })?.email ?? '').trim().toLowerCase();
  const password = String((body as { password?: unknown })?.password ?? '');

  const user = await db.user.findUnique({ where: { email } });
  // Always run a verify — against the real hash, or a dummy hash when the email
  // is unknown — so an unknown email costs the same scrypt work as a known one
  // (no user enumeration by response timing).
  const passwordOk = verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  // One generic 401 for EVERY failure mode — unknown email, wrong password,
  // neither allowlisted nor email-verified, or a BLOCKED account — so the
  // response never reveals which check failed (or whether the account exists).
  // Two entry paths since D7: the allowlist (seeded accounts) or a completed
  // email verification (self-service signup). See lib/auth: canAuthenticate.
  if (!user || !passwordOk || !canAuthenticate(user) || user.status === 'BLOCKED') {
    return NextResponse.json(
      { error: 'invalid_credentials', message: 'E-Mail oder Passwort ist falsch.' },
      { status: 401 },
    );
  }

  // Elevate an admin-listed account that signed up before being added to
  // ADMIN_EMAILS (or that was created as a normal user).
  let effective = user;
  if (isAdminEmail(email) && (user.role !== 'ADMIN' || user.status !== 'APPROVED')) {
    effective = await db.user.update({
      where: { id: user.id },
      data: {
        role: 'ADMIN',
        status: 'APPROVED',
        approvedAt: user.approvedAt ?? new Date(),
      },
    });
  }

  const res = NextResponse.json({
    email: effective.email,
    username: effective.username,
    status: effective.status,
    role: effective.role,
  });
  res.cookies.set(AUTH_COOKIE, authCookieValue(effective.id), authCookieOptions());
  return res;
}
