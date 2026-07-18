'use client';

/**
 * Shared, opt-in voice diagnostics. Enable in the browser console with:
 *   localStorage.setItem('aegis-voice-debug','1')   // disable: removeItem
 *
 * Read at call-time (not module load) so toggling takes effect without a
 * reload. Used across AegisVoiceMode, the client store, and speak.ts so the
 * full listen → send → generate → TTS → playback lifecycle can be traced and
 * timed end-to-end on any device.
 */
export function voiceDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('aegis-voice-debug') === '1';
  } catch {
    return false;
  }
}

export function vlog(...args: unknown[]): void {
  if (voiceDebugEnabled()) console.info('[voice]', ...args);
}

// ─────────────────────────── Timing store (Phase 0) ───────────────────────────
//
// In addition to the console line, every `vmark` is recorded into a small
// module-level store so a developer overlay can render the per-turn latency
// breakdown live. The store is consumed via `useSyncExternalStore` — the exact
// pattern the client store already uses — so we add no new state concept.
//
// Recording is gated by `voiceDebugEnabled()` (inside `vmark`): in production
// nothing is ever recorded and no listener is ever notified, so this is a true
// no-op for real users. The marker call sites are unchanged.

export type VoiceMark = { label: string; t: number };
export type VoiceTurn = { id: number; startedAt: number; marks: VoiceMark[] };
export type VoiceTimingSnapshot = { current: VoiceTurn | null; history: VoiceTurn[] };

const EMPTY_SNAPSHOT: VoiceTimingSnapshot = { current: null, history: [] };
// Keep a few completed turns so trends are visible without flooding memory.
const MAX_HISTORY = 8;

let current: VoiceTurn | null = null;
let history: VoiceTurn[] = [];
let snapshot: VoiceTimingSnapshot = EMPTY_SNAPSHOT;
let seq = 0;
const listeners = new Set<() => void>();

// Labels that mark the START of a fresh turn. Only a REPEAT of one of these
// rolls the current turn into history. Other labels can legitimately repeat
// within one turn (Phase 1 streams sentence-by-sentence, so the per-clip
// `ttsRequestedAt` / `ttsAudioReadyAt` fire once per sentence); delta math uses
// the FIRST occurrence, which is the one that gates time-to-first-audio.
const TURN_ANCHORS = new Set(['listeningStartedAt', 'sendMessageAt']);

function publish(): void {
  // New outer object on every mutation so useSyncExternalStore detects the
  // change; `current`/`history` references are reused where unchanged.
  snapshot = { current, history };
  for (const l of listeners) l();
}

function recordMark(label: string, t: number): void {
  // A repeated anchor label means a new turn is starting (e.g. the mic
  // reopening after Aegis spoke). Non-anchor repeats just append.
  if (
    current &&
    TURN_ANCHORS.has(label) &&
    current.marks.some((m) => m.label === label)
  ) {
    history = [current, ...history].slice(0, MAX_HISTORY);
    current = null;
  }
  if (!current) {
    current = { id: ++seq, startedAt: t, marks: [] };
  }
  current.marks.push({ label, t });
  publish();
}

/**
 * Timing marker. Logs the label with a high-resolution timestamp (ms since
 * page load) AND records it into the timing store (debug mode only):
 *   [voice-timing] listeningStartedAt 1234ms
 *   [voice-timing] finalTranscriptAt 4051ms
 *   ...
 */
export function vmark(label: string): void {
  if (!voiceDebugEnabled()) return;
  const t = typeof performance !== 'undefined' ? performance.now() : 0;
  console.info('[voice-timing]', label, `${t.toFixed(0)}ms`);
  recordMark(label, t);
}

// ── Store subscription API (for the overlay's useSyncExternalStore) ──
export function subscribeVoiceTiming(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVoiceTimingSnapshot(): VoiceTimingSnapshot {
  return snapshot;
}

export function getServerVoiceTimingSnapshot(): VoiceTimingSnapshot {
  // SSR / pre-hydration: render nothing so hydration matches.
  return EMPTY_SNAPSHOT;
}

/** Clear all recorded turns (overlay "Clear" button). */
export function resetVoiceTiming(): void {
  current = null;
  history = [];
  publish();
}

/**
 * Milliseconds between two marks in a turn, or null if either is missing
 * (e.g. the TTS marks are absent when the browser-fallback voice is used).
 */
export function markDelta(turn: VoiceTurn, from: string, to: string): number | null {
  const a = turn.marks.find((m) => m.label === from);
  const b = turn.marks.find((m) => m.label === to);
  if (!a || !b) return null;
  return b.t - a.t;
}
