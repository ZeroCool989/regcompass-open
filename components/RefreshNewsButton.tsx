"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Admin/local-owner trigger for the regulatory-news refresh. POSTs to the
 * refresh route (LLM-free RSS by default) and reloads the feed on success.
 */
export function RefreshNewsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/regulatory-news/refresh', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(data?.message ?? 'Aktualisierung fehlgeschlagen.');
        return;
      }
      setNote(
        data?.newsCreated > 0
          ? `${data.newsCreated} neue Meldung(en).`
          : 'Keine neuen Meldungen.',
      );
      router.refresh();
    } catch {
      setNote('Netzwerkfehler.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-50"
      >
        {busy ? 'Wird aktualisiert…' : 'Jetzt aktualisieren'}
      </button>
      {note && <span className="text-xs text-text-secondary">{note}</span>}
    </div>
  );
}
