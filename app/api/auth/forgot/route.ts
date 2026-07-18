import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { canAuthenticate, createResetToken, isDeployedEnv } from '@/lib/auth';
import { db } from '@/lib/db';
import { sendPasswordResetEmail } from '@/lib/email';

/**
 * Start a password reset. For an allowlisted email that has an account we mint a
 * hash-bound, 1-hour reset token (see lib/auth: createResetToken) and email the
 * link via Resend.
 *
 * Anti-enumeration: the response is ALWAYS the same generic body — for
 * allowlisted, non-allowlisted, and unknown emails alike. No link, no token, no
 * user-existence signal in the body or status. A Resend failure is logged
 * server-side and does NOT change the response.
 */

const limiter = rateLimit({ key: 'auth-forgot', limit: 5, windowMs: 15 * 60 * 1000 });

const GENERIC = {
  ok: true,
  message:
    'Falls ein Konto zu dieser E-Mail existiert, wurde ein Link zum Zurücksetzen gesendet.',
} as const;

export async function POST(req: NextRequest) {
  if (!(await limiter.check(ipHash(req))).ok) return NextResponse.json(GENERIC);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Ungültige Anfrage.' }, { status: 400 });
  }
  const email = String((body as { email?: unknown })?.email ?? '').trim().toLowerCase();

  // Only actually send for an account that is eligible to log in (allowlisted
  // or email-verified, D7). Everything else falls through to the identical
  // generic response below.
  if (email) {
    const user = await db.user.findUnique({ where: { email } });
    if (user && canAuthenticate(user)) {
      const token = createResetToken(email, user.passwordHash);
      // Reset links must never point at a request-derived host in deployed
      // envs (SEC-1: a spoofed Host header would land in the email). Fail
      // loud on misconfiguration instead of silently trusting the request.
      if (!process.env.APP_BASE_URL && isDeployedEnv()) {
        throw new Error(
          'APP_BASE_URL must be set in deployed environments — refusing to build a password-reset link from the request origin.',
        );
      }
      const base = process.env.APP_BASE_URL || req.nextUrl.origin;
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await sendPasswordResetEmail(email, resetUrl);
      } catch (err) {
        // A delivery failure must not change the response shape (no leak, no 500).
        console.warn(
          JSON.stringify({
            event: 'password_reset_email_failed',
            level: 'warn',
            message: err instanceof Error ? err.message : 'unknown',
          }),
        );
      }
    }
  }

  return NextResponse.json(GENERIC);
}
