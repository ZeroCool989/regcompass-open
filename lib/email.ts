/**
 * Transactional email via the Resend SDK. Configure with:
 *   RESEND_API_KEY     Resend API key (required to actually send)
 *   RESET_EMAIL_FROM   sender; defaults to Resend's built-in "onboarding@resend.dev"
 *                      (which only delivers to your own Resend account email until
 *                      you verify a domain and set a real From).
 *
 * sendPasswordResetEmail THROWS on failure — callers (the forgot route) wrap it
 * so a send error never changes the generic API response.
 */
import { Resend } from 'resend';

const FROM = process.env.RESET_EMAIL_FROM ?? 'onboarding@resend.dev';

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  // Instantiate lazily: a module-level `new Resend(undefined)` THROWS at import,
  // which breaks `next build` (page-data collection) and the route at runtime.
  // Lazy construction + an explicit guard keep the flow genuinely fail-closed
  // when the key is absent — the throw is caught by the forgot route → generic.
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set — cannot send reset email');
  const resend = new Resend(apiKey);

  const subject = 'RegCompass – Passwort zurücksetzen';
  const text = [
    'Hallo,',
    '',
    'Sie haben angefordert, Ihr RegCompass-Passwort zurückzusetzen.',
    '',
    'Klicken Sie auf den folgenden Link, um ein neues Passwort zu vergeben:',
    resetUrl,
    '',
    'Dieser Link ist aus Sicherheitsgründen 1 Stunde gültig und kann nur einmal verwendet werden.',
    '',
    'Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren – Ihr Passwort bleibt unverändert.',
    '',
    'Viele Grüße',
    'RegCompass',
  ].join('\n');

  const html = `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin-bottom: 16px;">Passwort zurücksetzen</h2>
    <p>Hallo,</p>
    <p>Sie haben angefordert, Ihr RegCompass-Passwort zurückzusetzen. Klicken Sie auf den Button, um ein neues Passwort zu vergeben:</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}" style="background: #1a1a1a; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Neues Passwort festlegen</a>
    </p>
    <p style="font-size: 14px; color: #555;">Dieser Link ist aus Sicherheitsgründen 1 Stunde gültig und kann nur einmal verwendet werden.</p>
    <p style="font-size: 14px; color: #555;">Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren – Ihr Passwort bleibt unverändert.</p>
    <p style="font-size: 14px;">Viele Grüße<br>RegCompass</p>
  </div>`;

  const { error } = await resend.emails.send({ from: FROM, to, subject, text, html });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}

/** Verification email for self-service signup (D7). Throws on failure — the
 * register route wraps it so a send error never changes the generic response. */
export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set — cannot send verification email');
  const resend = new Resend(apiKey);

  const subject = 'RegCompass – E-Mail-Adresse bestätigen';
  const text = [
    'Hallo,',
    '',
    'vielen Dank für Ihre Registrierung bei RegCompass.',
    '',
    'Klicken Sie auf den folgenden Link, um Ihre E-Mail-Adresse zu bestätigen:',
    verifyUrl,
    '',
    'Dieser Link ist aus Sicherheitsgründen 24 Stunden gültig.',
    '',
    'Nach der Bestätigung muss Ihr Konto noch von einem Administrator freigegeben werden, bevor Sie AEGIS nutzen können.',
    '',
    'Falls Sie sich nicht registriert haben, können Sie diese E-Mail ignorieren.',
    '',
    'Viele Grüße',
    'RegCompass',
  ].join('\n');

  const html = `
  <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin-bottom: 16px;">E-Mail-Adresse bestätigen</h2>
    <p>Hallo,</p>
    <p>vielen Dank für Ihre Registrierung bei RegCompass. Klicken Sie auf den Button, um Ihre E-Mail-Adresse zu bestätigen:</p>
    <p style="margin: 24px 0;">
      <a href="${verifyUrl}" style="background: #1a1a1a; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">E-Mail bestätigen</a>
    </p>
    <p style="font-size: 14px; color: #555;">Dieser Link ist aus Sicherheitsgründen 24 Stunden gültig.</p>
    <p style="font-size: 14px; color: #555;">Nach der Bestätigung muss Ihr Konto noch von einem Administrator freigegeben werden, bevor Sie AEGIS nutzen können.</p>
    <p style="font-size: 14px; color: #555;">Falls Sie sich nicht registriert haben, können Sie diese E-Mail ignorieren.</p>
    <p style="font-size: 14px;">Viele Grüße<br>RegCompass</p>
  </div>`;

  const { error } = await resend.emails.send({ from: FROM, to, subject, text, html });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
