'use client';

import { useState } from 'react';
import type { KbUpdateStatus, KbVersionInfo } from '@/lib/kb/version';

/**
 * Small, quiet strip above the KB browser: shows the bundled KB version + date
 * and lets the user check the public repo for a newer curated release. Applying
 * the update is deliberately a CLI step (`pnpm kb:update`) — the running app
 * never rewrites its own bundle — so on a hit we show that command rather than
 * a button that mutates files.
 */
export function KbVersionBanner({ local }: { local: KbVersionInfo }) {
  const [status, setStatus] = useState<KbUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  async function check() {
    setChecking(true);
    setFailed(false);
    try {
      const res = await fetch('/api/kb/version?check=1');
      if (!res.ok) throw new Error('bad status');
      setStatus((await res.json()) as KbUpdateStatus);
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }

  const updateAvailable = status?.updateAvailable === true;

  return (
    <div className="mb-6 rounded-lg border border-border-brand bg-surface/40 px-4 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-text-secondary">
          Wissensbasis-Version <span className="font-mono">{local.kbVersion}</span> · Stand{' '}
          {local.generatedAt} · {local.requirements} Anforderungen
        </span>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="rounded-md border border-border-brand px-2 py-1 font-medium text-text-secondary hover:text-brand-primary hover:border-brand-primary/40 disabled:opacity-50 transition-colors"
        >
          {checking ? 'Prüfe…' : 'Nach Updates suchen'}
        </button>
      </div>

      {updateAvailable ? (
        <p className="mt-2 text-brand-primary">
          Neue Version verfügbar: <span className="font-mono">{status?.remote?.kbVersion}</span> (Stand{' '}
          {status?.remote?.generatedAt}). Zum Aktualisieren im Projektordner ausführen:{' '}
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono">pnpm kb:update</code>
        </p>
      ) : null}
      {status && !updateAvailable && status.remote ? (
        <p className="mt-2 text-emerald-400">Die Wissensbasis ist aktuell. ✓</p>
      ) : null}
      {status && !updateAvailable && !status.remote ? (
        <p className="mt-2 text-text-secondary/70">
          Konnte keine Verbindung zur Update-Quelle herstellen (offline?).
        </p>
      ) : null}
      {failed ? (
        <p className="mt-2 text-text-secondary/70">Update-Prüfung fehlgeschlagen. Bitte erneut versuchen.</p>
      ) : null}
    </div>
  );
}
