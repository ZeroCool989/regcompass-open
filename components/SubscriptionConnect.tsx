"use client";

import { useEffect, useState } from 'react';

// German, user-actionable copy for the reasons the callback can hand back.
const ERROR_REASONS: Record<string, string> = {
  denied: 'Die Anmeldung wurde beim Anbieter abgebrochen.',
  missing: 'Der Anbieter hat die Anmeldung unvollständig zurückgegeben. Bitte erneut versuchen.',
  state: 'Sicherheitsprüfung fehlgeschlagen (abgelaufen oder erneut geöffnet). Bitte erneut anmelden.',
  exchange: 'Der Anbieter hat die Anmeldung nicht bestätigt. Bitte erneut versuchen.',
  setup: 'Für diesen Anbieter ist noch kein OAuth-Client hinterlegt.',
  session: 'Sitzung abgelaufen. Bitte erneut anmelden.',
};

/**
 * Connect a model subscription (Claude, ChatGPT, Gemini) via OAuth. Because
 * regcompass-open runs locally, the login happens on your own machine and the
 * token is stored locally — never on a shared server. Clicking "Mit … anmelden"
 * forwards the browser straight to the provider's own login page and brings it
 * back connected. Each provider shows one of three honest states: Setup
 * erforderlich (no OAuth client registered yet), ready-to-connect, or Verbunden.
 */

type ProviderView = {
  id: 'anthropic' | 'openai' | 'google';
  label: string;
  brand: string;
  mark: string;
  loginHost: string;
  loginUrl: string;
  status: 'unconfigured' | 'disconnected' | 'connected';
  setupHint: string;
  expiresAt: string | null;
  lastError: string | null;
};

type ReturnNotice = { kind: 'connected' | 'error'; brand: string; message?: string };

export function SubscriptionConnect() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReturnNotice | null>(null);

  async function load(): Promise<ProviderView[] | null> {
    const res = await fetch('/api/aegis/oauth', { cache: 'no-store' });
    if (!res.ok) return null;
    const list = (await res.json()).providers as ProviderView[];
    setProviders(list);
    return list;
  }

  // On return from the provider the callback redirects here with
  // ?subscription=<id>&result=connected|error[&reason=...]. Show a banner for
  // that round-trip, then strip the params so a refresh doesn't repeat it.
  useEffect(() => {
    void (async () => {
      const list = await load();
      const params = new URLSearchParams(window.location.search);
      const result = params.get('result');
      const id = params.get('subscription');
      if ((result === 'connected' || result === 'error') && id) {
        const brand = list?.find((p) => p.id === id)?.brand ?? id;
        setNotice(
          result === 'connected'
            ? { kind: 'connected', brand }
            : { kind: 'error', brand, message: ERROR_REASONS[params.get('reason') ?? ''] },
        );
        params.delete('subscription');
        params.delete('result');
        params.delete('reason');
        const qs = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
      }
    })();
  }, []);

  async function disconnect(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/aegis/oauth?provider=${id}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!providers) return null;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-heading font-semibold mb-1">Abo verbinden</h2>
      <p className="text-sm text-text-secondary mb-4 max-w-2xl">
        Verbinden Sie ein bestehendes Abo, statt einen API-Schlüssel zu hinterlegen. Ein Klick
        leitet Sie direkt zur Anmeldeseite des Anbieters weiter; die Anmeldung läuft lokal auf
        diesem Rechner und das Token verlässt Ihren Rechner nicht.
      </p>
      {notice && (
        <div
          role="status"
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            notice.kind === 'connected'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-danger/30 bg-danger/10 text-danger'
          }`}
        >
          {notice.kind === 'connected'
            ? `${notice.brand} verbunden — Sie sind zurück in der App und können AEGIS jetzt darüber betreiben.`
            : `${notice.brand}: Verbindung nicht abgeschlossen.${notice.message ? ` ${notice.message}` : ''}`}
        </div>
      )}
      <ul className="space-y-3">
        {providers.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-lg"
              >
                {p.mark}
              </span>
              <div className="min-w-0">
                <div className="font-medium">{p.label}</div>
                {p.status === 'disconnected' && (
                  <div className="text-xs text-text-secondary mt-0.5">
                    Weiterleitung zu {p.loginHost}
                  </div>
                )}
                {p.status === 'unconfigured' && (
                  <div className="text-xs text-text-secondary mt-0.5">
                    Setup erforderlich — {p.setupHint}{' '}
                    <a
                      href="https://github.com/ZeroCool989/regcompass-open/blob/main/docs/OAUTH_SETUP.md"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-primary hover:underline"
                    >
                      Anleitung
                    </a>
                  </div>
                )}
                {p.status === 'connected' && (
                  <div className="text-xs text-text-secondary mt-0.5">
                    Verbunden{p.expiresAt ? ` · gültig bis ${new Date(p.expiresAt).toLocaleString('de-DE')}` : ''}
                  </div>
                )}
                {p.lastError && <div className="text-xs text-danger mt-0.5">{p.lastError}</div>}
              </div>
            </div>
            <div className="shrink-0">
              {p.status === 'disconnected' && (
                <a
                  href={`/api/aegis/oauth/${p.id}/start`}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand-primary px-3 py-1.5 text-sm text-white no-underline hover:opacity-90"
                >
                  Mit {p.brand} anmelden
                  <span aria-hidden>→</span>
                </a>
              )}
              {p.status === 'unconfigured' && (
                <a
                  href={p.loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary no-underline hover:bg-surface-hover hover:text-foreground"
                >
                  {p.loginHost} öffnen
                  <span aria-hidden>↗</span>
                </a>
              )}
              {p.status === 'connected' && (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => disconnect(p.id)}
                  className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-50"
                >
                  Trennen
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
