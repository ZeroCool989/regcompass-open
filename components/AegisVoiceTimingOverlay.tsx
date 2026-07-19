'use client';

/**
 * Developer-only latency overlay for Voice Mode (Phase 0). Renders the per-turn
 * timing breakdown captured by `vmark` so we can see exactly where each voice
 * round spends its time. Self-gating: returns null unless the
 * `aegis-voice-debug` flag is set, so it is invisible (and inert) for real users.
 *
 * It only READS the timing store — it never changes voice behaviour.
 */

import { useSyncExternalStore } from 'react';
import {
  getServerVoiceTimingSnapshot,
  getVoiceTimingSnapshot,
  markDelta,
  resetVoiceTiming,
  subscribeVoiceTiming,
  voiceDebugEnabled,
  type VoiceTurn,
} from '@/lib/aegis/voice-debug';

// Each row is the gap between two markers. Order = chronological flow of a turn.
const SEGMENTS: Array<{ label: string; from: string; to: string }> = [
  { label: 'Zuhören (STT + Endpoint)', from: 'listeningStartedAt', to: 'finalTranscriptAt' },
  { label: 'Transkript → Senden', from: 'finalTranscriptAt', to: 'sendMessageAt' },
  { label: 'LLM: erstes Token (TTFT)', from: 'sendMessageAt', to: 'aegisFirstTokenAt' },
  { label: 'LLM: Generierung', from: 'aegisFirstTokenAt', to: 'aegisCompletedAt' },
  { label: 'Sprechdauer', from: 'speakingStartedAt', to: 'speakingFinishedAt' },
];

// The two metrics the user actually feels.
const HEADLINES: Array<{ label: string; from: string; to: string }> = [
  { label: '⭐ Zeit bis Audio', from: 'sendMessageAt', to: 'speakingStartedAt' },
  { label: 'Runde gesamt', from: 'finalTranscriptAt', to: 'speakingStartedAt' },
];

function fmt(ms: number | null): string {
  return ms == null ? '—' : `${Math.round(ms)} ms`;
}

function hasMark(turn: VoiceTurn, label: string): boolean {
  return turn.marks.some((m) => m.label === label);
}

export function AegisVoiceTimingOverlay() {
  const snap = useSyncExternalStore(
    subscribeVoiceTiming,
    getVoiceTimingSnapshot,
    getServerVoiceTimingSnapshot,
  );

  // Re-checked every render, so toggling the flag + running a turn reveals it.
  if (!voiceDebugEnabled()) return null;

  const turns = snap.current ? [snap.current, ...snap.history] : snap.history;
  // Show the most recent turn that actually reached playback (a full breakdown).
  const complete = turns.find((t) => hasMark(t, 'speakingStartedAt')) ?? null;
  // A turn still in flight (no audio yet) → show a live status line.
  const live =
    snap.current && !hasMark(snap.current, 'speakingStartedAt') ? snap.current : null;
  const liveLabel = live?.marks[live.marks.length - 1]?.label ?? null;

  return (
    <div className="fixed bottom-3 left-3 z-[110] w-72 rounded-lg border border-border-brand bg-background/90 backdrop-blur px-3 py-2 font-mono text-[11px] leading-tight text-text-secondary shadow-lg">
      <div className="flex items-center justify-between mb-1.5">
        <span className="uppercase tracking-wider text-[10px] text-brand-primary">
          Voice-Latenz · Debug
        </span>
        <button
          type="button"
          onClick={() => resetVoiceTiming()}
          className="text-[10px] text-text-secondary/60 hover:text-foreground"
        >
          Clear
        </button>
      </div>

      {complete ? (
        <>
          {HEADLINES.map((h) => (
            <div key={h.label} className="flex justify-between text-foreground font-semibold">
              <span>{h.label}</span>
              <span>{fmt(markDelta(complete, h.from, h.to))}</span>
            </div>
          ))}
          <div className="my-1.5 h-px bg-border-brand/60" />
          {SEGMENTS.map((s) => (
            <div key={s.label} className="flex justify-between">
              <span className="truncate pr-2">{s.label}</span>
              <span className="tabular-nums">{fmt(markDelta(complete, s.from, s.to))}</span>
            </div>
          ))}
          <div className="mt-1.5 text-[10px] text-text-secondary/50">Turn #{complete.id}</div>
        </>
      ) : (
        <div className="text-text-secondary/60">Warte auf ersten Voice-Turn …</div>
      )}

      {live ? (
        <div className="mt-1 text-[10px] text-brand-primary/80">
          läuft … zuletzt: {liveLabel ?? '—'}
        </div>
      ) : null}
    </div>
  );
}
