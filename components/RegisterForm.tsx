"use client";

import { useCallback, useState } from 'react';
import Link from 'next/link';

/** Self-service signup (D7). On success the API always answers with the same
 * generic message (anti-enumeration) — the form shows it and stops. */
export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message ?? 'Etwas ist schiefgelaufen.');
          return;
        }
        setDone(data?.message ?? 'Bitte prüfen Sie Ihr Postfach.');
      } catch {
        setError('Netzwerkfehler. Bitte erneut versuchen.');
      } finally {
        setBusy(false);
      }
    },
    [email, username, password],
  );

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <div className="text-3xl">📬</div>
        <p className="text-sm text-text-secondary">{done}</p>
        <p className="text-xs text-text-secondary/70">
          Nach der Bestätigung gibt ein Administrator Ihr Konto frei.
        </p>
        <Link
          href="/login"
          className="inline-block px-4 py-2 rounded-lg border border-border-brand text-sm text-text-secondary hover:text-brand-primary hover:border-brand-primary/50 transition-colors no-underline"
        >
          Zur Anmeldung
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
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="username">
          Anzeigename
        </label>
        <input
          id="username"
          type="text"
          autoComplete="nickname"
          required
          minLength={3}
          maxLength={40}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
        />
      </div>
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="password">
          Passwort <span className="text-text-secondary/60">(mind. 8 Zeichen)</span>
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
        />
      </div>

      {error ? (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 transition-colors disabled:opacity-50"
      >
        {busy ? 'Wird gesendet…' : 'Konto erstellen'}
      </button>

      <p className="text-center text-xs text-text-secondary">
        Bereits registriert?{' '}
        <Link href="/login" className="text-brand-primary hover:underline">
          Anmelden
        </Link>
      </p>
    </form>
  );
}
