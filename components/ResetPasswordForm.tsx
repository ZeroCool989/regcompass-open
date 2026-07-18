'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

function EyeButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? 'Passwort verbergen' : 'Passwort anzeigen'}
      aria-pressed={shown}
      title={shown ? 'Passwort verbergen' : 'Passwort anzeigen'}
      className="absolute inset-y-0 right-0 flex items-center px-3 text-text-secondary hover:text-brand-primary transition-colors"
    >
      {shown ? (
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
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (password.length < 8) {
        setError('Das Passwort muss mindestens 8 Zeichen lang sein.');
        return;
      }
      if (password !== confirm) {
        setError('Die Passwörter stimmen nicht überein.');
        return;
      }
      setBusy(true);
      try {
        const res = await fetch('/api/auth/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message ?? 'Zurücksetzen fehlgeschlagen.');
          return;
        }
        setDone(true);
        setTimeout(() => router.replace('/login'), 1500);
      } catch {
        setError('Netzwerkfehler. Bitte erneut versuchen.');
      } finally {
        setBusy(false);
      }
    },
    [password, confirm, token, router],
  );

  if (!token) {
    return (
      <div className="space-y-4 text-sm">
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-red-300">
          Der Link ist ungültig. Bitte fordern Sie einen neuen an.
        </div>
        <Link href="/forgot-password" className="text-brand-primary hover:underline">
          Neuen Link anfordern
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-300">
        Passwort aktualisiert. Sie werden zur Anmeldung weitergeleitet…
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="password">
          Neues Passwort
        </label>
        <div className="relative">
          <input
            id="password"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full pl-3 pr-10 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
          />
          <EyeButton shown={show} onToggle={() => setShow((v) => !v)} />
        </div>
      </div>
      <div>
        <label className="block text-xs text-text-secondary mb-1" htmlFor="confirm">
          Passwort bestätigen
        </label>
        <div className="relative">
          <input
            id="confirm"
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full pl-3 pr-10 py-2.5 rounded-lg border border-border-brand bg-surface/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
          />
          <EyeButton shown={show} onToggle={() => setShow((v) => !v)} />
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
        {busy ? '…' : 'Passwort setzen'}
      </button>
    </form>
  );
}
