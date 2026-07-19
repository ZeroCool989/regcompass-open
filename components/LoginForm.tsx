'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setBusy(true);
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message ?? 'Etwas ist schiefgelaufen.');
          return;
        }
        router.replace(next || '/aegis');
        router.refresh();
      } catch {
        setError('Netzwerkfehler. Bitte erneut versuchen.');
      } finally {
        setBusy(false);
      }
    },
    [email, password, next, router],
  );

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
        <label className="block text-xs text-text-secondary mb-1" htmlFor="password">
          Passwort
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full pl-3 pr-10 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
            aria-pressed={showPassword}
            title={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-text-secondary hover:text-brand-primary transition-colors"
          >
            {showPassword ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {error ? (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 disabled:opacity-50 transition-colors"
      >
        {busy ? '…' : 'Anmelden'}
      </button>

      <p className="text-center text-xs text-text-secondary">
        Noch kein Konto?{' '}
        <Link href="/register" className="text-brand-primary hover:underline">
          Registrieren
        </Link>
      </p>
    </form>
  );
}
