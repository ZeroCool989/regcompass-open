"use client";

import { useEffect, useState } from 'react';

type Provider = 'ANTHROPIC' | 'OPENAI' | 'GOOGLE';

type ProviderRow = {
  provider: Provider;
  label: string;
  configured: boolean;
  enabled: boolean;
  maskedKey: string | null;
  preferredModel: string;
  modelOptions: Array<{ id: string; label: string }>;
  modelNote: string | null;
  runtimeSupported: boolean;
  note: string;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
};

type Settings = { preferredProvider: Provider | null; providers: ProviderRow[] };

type ClaudeOAuth = {
  status: 'unconfigured' | 'ready';
  setupMessage: string | null;
  connection: {
    connected: boolean;
    connectedAt: string | null;
    expiresAt: string | null;
    scope: string | null;
    lastError: string | null;
  };
  runtimeActive: boolean;
};

export function AiProviderSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [claude, setClaude] = useState<ClaudeOAuth | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});

  async function load() {
    const [res, oauthRes] = await Promise.all([
      fetch('/api/aegis/providers'),
      fetch('/api/aegis/providers/claude-oauth'),
    ]);
    if (res.ok) setSettings(await res.json());
    if (oauthRes.ok) setClaude(await oauthRes.json());
  }

  useEffect(() => {
    void load();
    // Callback feedback (?claude=connected|error) from the OAuth redirect.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('claude');
    if (outcome === 'connected') setMessage('Claude-Abo verbunden.');
    else if (outcome === 'error') {
      setMessage('Die Verbindung mit Claude hat nicht geklappt. Bitte erneut versuchen.');
    }
    if (outcome) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function disconnectClaude() {
    setBusy('claude-oauth');
    setMessage(null);
    try {
      await fetch('/api/aegis/providers/claude-oauth', { method: 'DELETE' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function save(provider: Provider) {
    setBusy(provider);
    setMessage(null);
    try {
      const res = await fetch('/api/aegis/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey: apiKeys[provider] ?? '',
          preferredModel: models[provider] ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.message ?? 'Konnte Credential nicht speichern.');
        return;
      }
      setApiKeys((prev) => ({ ...prev, [provider]: '' }));
      setMessage('Gespeichert.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function prefer(provider: Provider | null) {
    setBusy(provider ?? 'system');
    setMessage(null);
    try {
      const res = await fetch('/api/aegis/providers', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredProvider: provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.message ?? 'Konnte Provider nicht auswählen.');
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(provider: Provider) {
    setBusy(provider);
    setMessage(null);
    try {
      await fetch(`/api/aegis/providers?provider=${provider}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!settings) return <p className="text-sm text-text-secondary">Lädt…</p>;

  return (
    <div className="space-y-5">
      {message ? <div className="rounded-md border border-border-brand px-3 py-2 text-sm text-text-secondary">{message}</div> : null}
      <section className="rounded-lg border border-border-brand p-4 space-y-2 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">Claude-Abo verbinden</h2>
            <p className="text-xs text-text-secondary mt-1">
              &bdquo;Mit Claude anmelden&ldquo;: AEGIS läuft dann über Ihr eigenes Claude-Konto
              (Abrechnung über Ihre Anthropic Extra-Usage-Credits) — ganz ohne API-Schlüssel.
            </p>
          </div>
          {claude?.connection.connected ? (
            <span className="text-xs text-emerald-400 whitespace-nowrap">✓ verbunden</span>
          ) : null}
        </div>
        {claude === null ? (
          <p className="text-xs text-text-secondary">Lädt…</p>
        ) : claude.status === 'unconfigured' ? (
          <>
            <button
              type="button"
              disabled
              className="rounded-md border border-border-brand px-3 py-1.5 text-xs opacity-40 cursor-not-allowed"
            >
              Mit Claude anmelden
            </button>
            <p className="text-xs text-amber-300/90">{claude.setupMessage}</p>
          </>
        ) : claude.connection.connected ? (
          <>
            <p className="text-xs text-text-secondary">
              Verbunden seit {new Date(claude.connection.connectedAt ?? '').toLocaleDateString('de-DE')}.
              {claude.runtimeActive
                ? ' Aktiv für AEGIS-Anfragen.'
                : ' Noch nicht für AEGIS-Anfragen aktiv — die Freischaltung folgt, sobald Anthropic die Vertragsdetails bereitstellt. Ihr API-Schlüssel (falls hinterlegt) wird weiterhin verwendet.'}
            </p>
            {claude.connection.lastError ? (
              <p className="text-xs text-amber-300">{claude.connection.lastError}</p>
            ) : null}
            <button
              type="button"
              disabled={busy === 'claude-oauth'}
              onClick={() => void disconnectClaude()}
              className="rounded-md border border-red-400/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40"
            >
              Trennen
            </button>
          </>
        ) : (
          <a
            href="/api/aegis/providers/claude-oauth/start"
            className="inline-block rounded-md border border-brand-primary/50 bg-brand-primary/10 px-3 py-1.5 text-xs font-semibold text-brand-primary"
          >
            Mit Claude anmelden
          </a>
        )}
      </section>
      <div className="rounded-lg border border-border-brand p-4 text-sm text-text-secondary">
        <p className="font-semibold text-foreground mb-1">System-Provider</p>
        <p>Ohne Auswahl nutzt AEGIS den serverseitigen Anthropic-Key. Nutzer-Keys werden nie an den Browser zurückgegeben.</p>
        <button
          type="button"
          onClick={() => prefer(null)}
          className="mt-3 rounded-md border border-border-brand px-3 py-1.5 text-xs hover:border-brand-primary/50"
        >
          System-Provider verwenden
        </button>
      </div>
      {settings.providers.map((p) => {
        const preferred = settings.preferredProvider === p.provider;
        return (
          <section key={p.provider} className="rounded-lg border border-border-brand p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-foreground">{p.label}</h2>
                <p className="text-xs text-text-secondary mt-1">{p.note}</p>
              </div>
              <div className="text-right text-xs">
                {preferred ? <span className="text-emerald-400">✓ aktiv</span> : null}
                {p.configured ? <div className="text-text-secondary">{p.maskedKey}</div> : <div className="text-text-secondary">nicht konfiguriert</div>}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
              <input
                type="password"
                value={apiKeys[p.provider] ?? ''}
                onChange={(e) => setApiKeys((prev) => ({ ...prev, [p.provider]: e.target.value }))}
                placeholder="API Key einfügen"
                className="rounded-md border border-border-brand bg-background px-3 py-2 text-sm"
              />
              {p.modelOptions.length > 0 ? (
                <select
                  value={models[p.provider] ?? p.preferredModel}
                  onChange={(e) => setModels((prev) => ({ ...prev, [p.provider]: e.target.value }))}
                  className="rounded-md border border-border-brand bg-background px-3 py-2 text-sm"
                  aria-label={`${p.label} bevorzugtes Modell`}
                >
                  {p.modelOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={models[p.provider] ?? p.preferredModel}
                  onChange={(e) => setModels((prev) => ({ ...prev, [p.provider]: e.target.value }))}
                  className="rounded-md border border-border-brand bg-background px-3 py-2 text-sm"
                  aria-label={`${p.label} Modell`}
                />
              )}
            </div>
            {p.modelNote ? <p className="text-xs text-text-secondary/80">{p.modelNote}</p> : null}
            {p.lastValidationError ? <p className="text-xs text-amber-300">{p.lastValidationError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy === p.provider} onClick={() => save(p.provider)} className="rounded-md border border-brand-primary/50 bg-brand-primary/10 px-3 py-1.5 text-xs font-semibold text-brand-primary disabled:opacity-50">Speichern</button>
              <button type="button" disabled={!p.configured || busy === p.provider || !p.runtimeSupported} onClick={() => prefer(p.provider)} className="rounded-md border border-border-brand px-3 py-1.5 text-xs disabled:opacity-40">Für AEGIS verwenden</button>
              <button type="button" disabled={!p.configured || busy === p.provider} onClick={() => remove(p.provider)} className="rounded-md border border-red-400/40 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40">Entfernen</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
