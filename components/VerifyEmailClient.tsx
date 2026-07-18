"use client";

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

/** Confirms the verification token from the emailed link (D7). POSTs once on
 * mount; the endpoint is idempotent, so a reload is harmless. */
export function VerifyEmailClient({ token }: { token: string | null }) {
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error');
  const [message, setMessage] = useState<string | null>(
    token ? null : 'Kein Bestätigungs-Token in der URL. Bitte verwenden Sie den Link aus der E-Mail.',
  );
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true; // React StrictMode double-invokes effects in dev
    (async () => {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        setMessage(data?.message ?? (res.ok ? 'E-Mail-Adresse bestätigt.' : 'Der Link ist ungültig oder abgelaufen.'));
        setState(res.ok ? 'ok' : 'error');
      } catch {
        setMessage('Netzwerkfehler. Bitte laden Sie die Seite neu.');
        setState('error');
      }
    })();
  }, [token]);

  return (
    <div className="space-y-4 text-center">
      <div className="text-3xl">{state === 'working' ? '⏳' : state === 'ok' ? '✅' : '⚠️'}</div>
      <h1 className="text-lg font-heading font-bold">
        {state === 'working' ? 'E-Mail wird bestätigt…' : state === 'ok' ? 'E-Mail bestätigt' : 'Bestätigung fehlgeschlagen'}
      </h1>
      {message ? <p className="text-sm text-text-secondary">{message}</p> : null}
      {state !== 'working' ? (
        <Link
          href={state === 'ok' ? '/login' : '/register'}
          className="inline-block px-4 py-2 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 transition-colors no-underline"
        >
          {state === 'ok' ? 'Zur Anmeldung' : 'Erneut registrieren'}
        </Link>
      ) : null}
    </div>
  );
}
