'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      try {
        await fetch('/api/auth/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      } catch {
        /* ignore — we always show the same generic confirmation */
      } finally {
        setBusy(false);
        setSent(true);
      }
    },
    [email],
  );

  if (sent) {
    return (
      <div className="space-y-4 text-sm">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-emerald-300">
          Falls ein Konto zu dieser E-Mail existiert, wurde ein Link zum
          Zurücksetzen des Passworts gesendet. Der Link ist 1 Stunde gültig.
        </div>
        <Link href="/login" className="text-brand-primary hover:underline">
          Zurück zur Anmeldung
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="email">
          E-Mail
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 disabled:opacity-50 transition-colors"
      >
        {busy ? '…' : 'Link senden'}
      </button>
      <div className="text-center">
        <Link href="/login" className="text-xs text-text-secondary hover:text-brand-primary">
          Zurück zur Anmeldung
        </Link>
      </div>
    </form>
  );
}
