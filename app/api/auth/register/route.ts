import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { authMode, hashPassword, isAdminEmail, isAllowlisted, allowlistEmails } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Self-service signup for the local build. Runs fully offline — no email
 * verification round-trip; `emailVerifiedAt` is stamped at creation so
 * `canAuthenticate` admits the account immediately.
 *
 * Bootstrap rule: the FIRST account on a fresh database becomes an APPROVED
 * ADMIN (whoever installs the instance administers it). Every later account is
 * created as PENDING USER and must be approved in /admin/users before AEGIS
 * opens up. Accounts on ADMIN_EMAILS are also admitted as approved admins.
 *
 * When AUTH_ALLOWLIST is set, registration is restricted to the listed
 * addresses; when empty (default), anyone who can reach the instance may
 * register.
 */

const limiter = rateLimit({ key: 'auth-register', limit: 5, windowMs: 15 * 60 * 1000 });

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,38}[\p{L}\p{N}]$/u;

export async function POST(req: NextRequest) {
  if (authMode() === 'local') {
    return NextResponse.json(
      { error: 'auth_disabled', message: 'Diese Installation läuft ohne Konten — eine Registrierung ist nicht nötig.' },
      { status: 404 },
    );
  }
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

  if (allowlistEmails().size > 0 && !isAllowlisted(email)) {
    return NextResponse.json(
      {
        error: 'not_allowlisted',
        message: 'Die Registrierung ist auf eingeladene E-Mail-Adressen beschränkt.',
      },
      { status: 403 },
    );
  }

  const nameTaken = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (nameTaken) {
    return NextResponse.json(
      { error: 'username_taken', message: 'Dieser Anzeigename ist bereits vergeben.' },
      { status: 409 },
    );
  }
  const emailTaken = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (emailTaken) {
    return NextResponse.json(
      { error: 'email_taken', message: 'Diese E-Mail-Adresse ist bereits registriert.' },
      { status: 409 },
    );
  }

  // First account on a fresh DB → approved admin. Counted inside the same
  // transaction as the insert so two concurrent first registrations cannot
  // both win the bootstrap. Databases from the earlier passwordless build
  // contain an implicit `local` row (empty passwordHash) — it cannot log in,
  // does not count as an account, and its data is handed to the first admin.
  const passwordHash = hashPassword(password);
  const user = await db.$transaction(async (tx) => {
    const legacy = await tx.user.findUnique({ where: { id: 'local' } });
    const existing = await tx.user.count({ where: { NOT: { passwordHash: '' } } });
    const admin = existing === 0 || isAdminEmail(email);
    const created = await tx.user.create({
      data: {
        email,
        username,
        passwordHash,
        role: admin ? 'ADMIN' : 'USER',
        status: admin ? 'APPROVED' : 'PENDING',
        approvedAt: admin ? new Date() : null,
        emailVerifiedAt: new Date(),
        ...(legacy && existing === 0
          ? {
              voiceId: legacy.voiceId,
              voicePrefs: legacy.voicePrefs ?? undefined,
              preferredAiProvider: legacy.preferredAiProvider,
            }
          : {}),
      },
    });
    if (legacy && existing === 0) {
      const move = { where: { userId: legacy.id }, data: { userId: created.id } };
      await tx.aegisConversation.updateMany(move);
      await tx.userAiCredential.updateMany(move);
      await tx.userClaudeOAuth.updateMany(move);
      await tx.soulEntry.updateMany(move);
      await tx.soulProposal.updateMany(move);
      await tx.soulAudit.updateMany(move);
      await tx.user.delete({ where: { id: legacy.id } });
    }
    return created;
  });

  return NextResponse.json({
    ok: true,
    status: user.status,
    message:
      user.status === 'APPROVED'
        ? 'Konto erstellt. Sie können sich jetzt anmelden.'
        : 'Konto erstellt. Ein Administrator muss es freigeben, bevor Sie AEGIS nutzen können.',
  });
}
