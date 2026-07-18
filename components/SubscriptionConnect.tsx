"use client";

import { useEffect, useState } from 'react';

/**
 * Connect a model subscription (Claude, ChatGPT, Gemini) via OAuth. Because
 * regcompass-open runs locally, the login happens on your own machine and the
 * token is stored locally — never in a shared server. Each provider shows one of
 * three honest states: Setup erforderlich (no OAuth client registered yet),
 * Anmelden (ready to connect), or Verbunden (connected, with Trennen).
 */

type ProviderView = {
  id: 'anthropic' | 'openai' | 'google';
  label: string;
  status: 'unconfigured' | 'disconnected' | 'connected';
  setupHint: string;
  expiresAt: string | null;
  lastError: string | null;
};

export function SubscriptionConnect() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/aegis/oauth', { cache: 'no-store' });
    if (res.ok) setProviders((await res.json()).providers as ProviderView[]);
  }

  useEffect(() => {
    void load();
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
        Verbinden Sie ein bestehendes Abo, statt einen API-Schlüssel zu hinterlegen. Die Anmeldung
        läuft lokal auf diesem Rechner; das Token verlässt Ihren Rechner nicht.
      </p>
      <ul className="space-y-3">
        {providers.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3"
          >
            <div className="min-w-0">
              <div className="font-medium">{p.label}</div>
              {p.status === 'unconfigured' && (
                <div className="text-xs text-text-secondary mt-0.5">Setup erforderlich — {p.setupHint}</div>
              )}
              {p.status === 'connected' && (
                <div className="text-xs text-text-secondary mt-0.5">
                  Verbunden{p.expiresAt ? ` · gültig bis ${new Date(p.expiresAt).toLocaleString('de-DE')}` : ''}
                </div>
              )}
              {p.lastError && <div className="text-xs text-danger mt-0.5">{p.lastError}</div>}
            </div>
            <div className="shrink-0">
              {p.status === 'unconfigured' && (
                <span className="text-xs text-text-secondary">Setup erforderlich</span>
              )}
              {p.status === 'disconnected' && (
                <a
                  href={`/api/aegis/oauth/${p.id}/start`}
                  className="inline-flex items-center rounded-md bg-brand-primary px-3 py-1.5 text-sm text-white no-underline hover:opacity-90"
                >
                  Anmelden
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
