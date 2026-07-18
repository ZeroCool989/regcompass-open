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
  type ContextHealth,
  type FullnessBand,
  type HealthTurn,
} from '@/lib/aegis/context-health';
import { useSyncExternalStore } from 'react';

// ─── Fullness meter (the "context fills up and turns red" gauge) ───
// Higher fullness is WORSE: green with room to spare, red when nearly full.
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

/** Build a `████████░░░░░░░░` block bar for a 0–100 percentage. */
function blockBar(pct: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return '█'.repeat(filled) + '░'.repeat(cells - filled);
}

/**
 * Context fullness meter: `[████████░░░░░░░░] 42% 🟢`. Colour + emoji track how
 * full the working context window is — green → yellow → red as it fills.
 */
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

const BAND_TINT: Record<ContextHealth['band'], string> = {
  excellent: 'text-emerald-400 border-emerald-500/40',
  good: 'text-emerald-400 border-emerald-500/40',
  attention: 'text-amber-400 border-amber-500/40',
  compress: 'text-red-400 border-red-500/40',
};

const BAND_LABEL: Record<ContextHealth['band'], string> = {
  excellent: 'Sehr gut',
  good: 'Gut',
  attention: 'Bitte aufpassen',
  compress: 'Besser aufräumen',
};

function toTurns(messages: ChatMessage[]): HealthTurn[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallCount: m.meta?.toolCalls.length ?? 0,
    inputTokens: m.meta?.cost.inputTokens,
    cachedTokens: m.meta?.cost.cachedTokens,
  }));
}

/** Penalty (0 good – 1 bad) → einfaches Mengen-Wort. */
function penaltyLabel(p: number): string {
  return p < 0.33 ? 'wenig' : p < 0.66 ? 'mittel' : 'viel';
}
/** Quality (0 bad – 1 good) → einfaches Mengen-Wort. */
function qualityLabel(q: number): string {
  return q > 0.66 ? 'hoch' : q > 0.33 ? 'mittel' : 'niedrig';
}

function Bar({ value, good }: { value: number; good?: boolean }) {
  // value is a penalty (0..1); for "good" metrics pass the quality directly.
  const filled = Math.round(value * 6);
  const tint = good
    ? value > 0.66
      ? 'bg-emerald-400'
      : value > 0.33
        ? 'bg-amber-400'
        : 'bg-red-400'
    : value < 0.33
      ? 'bg-emerald-400'
      : value < 0.66
        ? 'bg-amber-400'
        : 'bg-red-400';
  return (
    <span className="inline-flex gap-0.5" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-sm ${i < filled ? tint : 'bg-border-brand/60'}`}
        />
      ))}
    </span>
  );
}

/**
 * Always-visible Context Health indicator for the Aegis header. Computes a
 * signal-density health score from the live chat store (no server round-trip)
 * and shows a ring + expandable factor breakdown. This is a heuristic estimate,
 * deliberately not a token-utilization gauge — see lib/aegis/context-health.ts.
 */
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

  // Nothing to measure before the conversation starts.
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
        {/* Compact fallback on small screens: just % + emoji */}
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

          <div className="border-t border-border-brand/60 pt-3 mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary">So gut läuft das Gespräch</span>
            <span className={`text-xs font-mono ${BAND_TINT[health.band].split(' ')[0]}`}>
              {BAND_LABEL[health.band]}
            </span>
          </div>

          <dl className="space-y-2 text-xs">
            <Row label="Wiederholungen" value={penaltyLabel(health.factors.redundancy)}>
              <Bar value={health.factors.redundancy} />
            </Row>
            <Row label="Zusatz-Daten" value={penaltyLabel(health.factors.toolLoad)}>
              <Bar value={health.factors.toolLoad} />
            </Row>
            <Row label="Klarheit" value={qualityLabel(health.factors.signalDensity)}>
              <Bar value={health.factors.signalDensity} good />
            </Row>
            <Row label="Offene Fragen" value={String(Math.round(health.factors.openLoops * 3))} />
          </dl>

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
                aufgeräumt werden — es gibt viele Wiederholungen oder Zusatz-Daten.
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

          <p className="mt-3 text-[0.7rem] text-text-secondary/70 leading-snug">
            Oben siehst du, wie voll der Speicher für diesen Chat ist. Die Qualität
            unten ist ein geschätzter Richtwert.
          </p>

          <details className="mt-3 text-[0.7rem] text-text-secondary/80 leading-snug">
            <summary className="cursor-pointer select-none text-text-secondary hover:text-foreground">
              Wie wird das geschätzt?
            </summary>
            <div className="mt-1.5 space-y-1">
              <p>
                Das System liest nicht wirklich mit. Es zählt nur Muster im
                Gespräch und macht daraus einen Daumenwert:
              </p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>
                  <span className="text-foreground">Wiederholungen</span> – sagt
                  der Chat immer wieder dasselbe? (zählt am stärksten)
                </li>
                <li>
                  <span className="text-foreground">Zusatz-Daten</span> – wie viel
                  Extra-Material (Suchen, Nachschlagen) wurde geladen?
                </li>
                <li>
                  <span className="text-foreground">Klarheit</span> – ist das
                  Gespräch auf den Punkt oder schwammig?
                </li>
                <li>
                  <span className="text-foreground">Offene Fragen</span> – sind
                  Fragen unbeantwortet geblieben?
                </li>
              </ul>
              <p>
                Je weniger Wiederholungen und Ballast, desto besser. Weil das
                System den Inhalt nicht versteht, ist es ein Richtwert – kein
                exaktes Urteil.
              </p>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className="text-foreground">{value}</span>
        {children}
      </dd>
    </div>
  );
}
