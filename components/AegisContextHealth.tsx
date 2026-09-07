'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
  type ChatMessage,
} from '@/lib/aegis/client-store';
import {
  COMPACT_TRIGGER,
  computeContextHealth,
  fullnessBand,
  type FullnessBand,
  type HealthTurn,
} from '@/lib/aegis/context-health';
import { useSyncExternalStore } from 'react';

// ─── Fullness meter (the "context fills up and turns red" gauge) ───
const FULL_TEXT: Record<FullnessBand, string> = {
  low: 'text-emerald-400',
  mid: 'text-amber-400',
  high: 'text-red-400',
};
const FULL_BORDER: Record<FullnessBand, string> = {
  low: 'border-emerald-500/40',
  mid: 'border-amber-500/40',
  high: 'border-red-500/40',
};
const FULL_EMOJI: Record<FullnessBand, string> = {
  low: '🟢',
  mid: '🟡',
  high: '🔴',
};

/** Build a block bar for a 0-100 percentage. */
function blockBar(pct: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

function ContextMeter({
  pct,
  cells,
  className = '',
}: {
  pct: number;
  cells: number;
  className?: string;
}) {
  const band = fullnessBand(pct);
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${FULL_TEXT[band]} ${className}`}
    >
      <span aria-hidden="true">
        [<span className="tracking-tighter">{blockBar(pct, cells)}</span>]
      </span>
      <span className="font-semibold">{pct}%</span>
      <span aria-hidden="true">{FULL_EMOJI[band]}</span>
    </span>
  );
}

function toTurns(messages: ChatMessage[]): HealthTurn[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    inputTokens: m.meta?.cost.inputTokens,
    cachedTokens: m.meta?.cost.cachedTokens,
  }));
}

export function AegisContextHealth() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactNote, setCompactNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const conversationId = state.conversationId;

  async function compact() {
    if (!conversationId) return;
    setCompacting(true);
    setCompactNote(null);
    try {
      const res = await fetch(`/api/aegis/conversations/${conversationId}/compact`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      setCompactNote(
        res.ok
          ? data.message ?? 'Chat aufgeräumt.'
          : data.message ?? 'Aufräumen hat nicht geklappt.',
      );
    } catch {
      setCompactNote('Netzwerkfehler beim Aufräumen.');
    } finally {
      setCompacting(false);
    }
  }

  const health = useMemo(
    () => computeContextHealth(toTurns(state.messages)),
    [state.messages],
  );

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (state.messages.length === 0) return null;

  const fBand = health.fullnessBand;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Speicher ${health.fullnessPct}% voll`}
        aria-label={`Speicher ${health.fullnessPct} Prozent voll`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-surface/60 ${FULL_BORDER[fBand]}`}
      >
        <span className="hidden md:inline">
          <ContextMeter pct={health.fullnessPct} cells={10} />
        </span>
        <span
          className={`md:hidden inline-flex items-center gap-1 font-mono tabular-nums ${FULL_TEXT[fBand]}`}
        >
          <span className="font-semibold">{health.fullnessPct}%</span>
          <span aria-hidden="true">{FULL_EMOJI[fBand]}</span>
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          className="absolute right-0 mt-2 w-72 rounded-xl border border-border-brand bg-surface shadow-xl shadow-black/30 p-4 z-50"
        >
          <div className="mb-3">
            <span className="text-sm font-semibold">Kontext-Fenster</span>
            <div className="mt-2">
              <ContextMeter pct={health.fullnessPct} cells={16} className="text-sm" />
            </div>
            <p className="mt-1.5 text-[0.7rem] text-text-secondary/80">
              Etwa {(health.approxTokens / 1000).toFixed(1)}K von{' '}
              {Math.round(COMPACT_TRIGGER / 1000)}K belegt. Ist er voll, räumt das
              System von selbst auf.
            </p>
          </div>

          {health.recommendCompaction !== 'none' && !compactNote ? (
            <div
              className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                health.recommendCompaction === 'hard'
                  ? 'border-red-500/40 text-red-300 bg-red-500/10'
                  : 'border-amber-500/40 text-amber-200 bg-amber-500/10'
              }`}
            >
              <p className="mb-2">
                Der Chat sollte {health.recommendCompaction === 'hard' ? 'bald ' : ''}
                aufgeräumt werden.
              </p>
              <button
                type="button"
                onClick={compact}
                disabled={compacting || !conversationId}
                className="w-full rounded-md border border-brand-primary/50 bg-brand-primary/10 px-3 py-1.5 text-xs font-semibold text-brand-primary hover:bg-brand-primary/20 disabled:opacity-50 transition-colors"
                title={conversationId ? undefined : 'Noch kein gespeichertes Gespräch'}
              >
                {compacting ? 'Wird aufgeräumt…' : 'Chat aufräumen'}
              </button>
            </div>
          ) : null}

          {compactNote ? (
            <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              {compactNote}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
