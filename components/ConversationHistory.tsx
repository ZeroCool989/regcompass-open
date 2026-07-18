'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { openConversation } from '@/lib/aegis/client-store';

type ConversationSummary = {
  id: string;
  mode: string;
  language: string;
  title: string | null;
  createdAt: string;
  lastTurnAt: string;
};

const MODE_LABEL: Record<string, string> = {
  CONVERSATIONAL: 'Conversational',
  ASSESS: 'Assess',
  GAP_ANALYZE: 'Gap Analyze',
  CONTROL_ADVISE: 'Control Advise',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ConversationHistory() {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/aegis/conversations');
        const data = await res.json();
        if (!cancelled) setConversations(data.conversations ?? []);
      } catch {
        if (!cancelled) setError('Verlauf konnte nicht geladen werden.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = useCallback(
    async (id: string) => {
      setOpeningId(id);
      const ok = await openConversation(id);
      if (ok) {
        router.push('/aegis');
      } else {
        setError('Diese Unterhaltung ist nicht mehr verfügbar.');
        setConversations((prev) => prev.filter((c) => c.id !== id));
        setOpeningId(null);
      }
    },
    [router],
  );

  if (loading) return <p className="text-sm text-text-secondary">Lädt…</p>;

  if (error && conversations.length === 0) {
    return <p className="text-sm text-red-400">{error}</p>;
  }

  if (conversations.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        Noch keine Gespräche. Starten Sie eine Unterhaltung in{' '}
        <a href="/aegis" className="text-brand-primary hover:underline">
          AEGIS
        </a>
        .
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <ul className="divide-y divide-border-brand/40 rounded-lg border border-border-brand overflow-hidden">
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => open(c.id)}
              disabled={openingId === c.id}
              className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-surface/60 transition-colors disabled:opacity-50"
            >
              <div className="min-w-0">
                <div className="text-sm text-foreground truncate">
                  {c.title || 'Unbenannte Unterhaltung'}
                </div>
                <div className="text-xs text-text-secondary/70 mt-0.5">
                  {formatDate(c.lastTurnAt)}
                </div>
              </div>
              <span className="shrink-0 text-[0.65rem] font-mono px-2 py-0.5 rounded border border-border-brand text-text-secondary">
                {MODE_LABEL[c.mode] ?? c.mode}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
