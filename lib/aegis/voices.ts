/**
 * Provider-agnostic Aegis voice catalog (Phase 4 — Voice Identity).
 *
 * A voice preference is a portable token, independent of the TTS provider:
 *   "cartesia:<uuid>"     — a specific Cartesia (sonic-3) German voice
 *   "browser"             — the device's default German Web Speech voice
 *   "browser:<voiceURI>"  — a specific OS/browser voice (device-specific, best-effort)
 *   null / ""             — the Aegis default (the recommended voice)
 *
 * The catalog wraps the Cartesia German voice list; adding another provider is
 * a matter of appending entries with a new `provider` — nothing else here is
 * Cartesia-specific. Pure + dependency-light so it runs on client and server.
 */

import { CARTESIA_GERMAN_VOICES, DEFAULT_CARTESIA_VOICE_ID } from './cartesia-voices';

export type VoiceProvider = 'cartesia' | 'browser';

export interface AegisVoice {
  /** Preference token (see module doc). */
  id: string;
  provider: VoiceProvider;
  name: string;
  gender?: 'feminine' | 'masculine';
  language: string;
  /** The one recommended default voice. */
  recommended?: boolean;
}

export const CARTESIA_PREFIX = 'cartesia:';
export const BROWSER_VOICE_ID = 'browser';

export function cartesiaVoiceId(uuid: string): string {
  return `${CARTESIA_PREFIX}${uuid}`;
}

/**
 * The recommended default Aegis voice: Sebastian (Orator) — German, masculine,
 * Cartesia sonic-3. An authoritative, advisory German voice — German-first by
 * design, and a fitting default for a Swiss/EU compliance advisor.
 */
export const DEFAULT_VOICE_ID = cartesiaVoiceId(DEFAULT_CARTESIA_VOICE_ID);

export const AEGIS_VOICES: AegisVoice[] = [
  ...CARTESIA_GERMAN_VOICES.map(
    (v): AegisVoice => ({
      id: cartesiaVoiceId(v.id),
      provider: 'cartesia',
      name: v.name,
      gender: v.gender,
      language: 'de',
      recommended: cartesiaVoiceId(v.id) === DEFAULT_VOICE_ID,
    }),
  ),
  {
    id: BROWSER_VOICE_ID,
    provider: 'browser',
    name: 'Browser-Stimme (Google)',
    language: 'de',
  },
];

/** German sample line used for voice previews. */
export const VOICE_SAMPLE_DE =
  'Guten Tag, ich bin AEGIS, Ihr KI-Regulatorik-Berater. So klinge ich.';

/** Accepts catalog ids, the generic/specific browser tokens, and null (= default). */
export function isValidVoiceId(id: string | null | undefined): boolean {
  if (id == null || id === '') return true;
  if (id === BROWSER_VOICE_ID || id.startsWith('browser:')) return true;
  return AEGIS_VOICES.some((v) => v.id === id);
}

/** Resolve a stored preference to a concrete voice token (null → default). */
export function resolveVoiceId(pref: string | null | undefined): string {
  return pref && pref.length > 0 ? pref : DEFAULT_VOICE_ID;
}

export function voiceById(id: string): AegisVoice | undefined {
  return AEGIS_VOICES.find((v) => v.id === id);
}

/** Recommended-first, then feminine/masculine grouping is left to the UI. */
export const RECOMMENDED_VOICE = AEGIS_VOICES.find((v) => v.recommended)!;

// ───────────────────────── Voice experience preferences ─────────────────────────

export interface VoicePrefs {
  /** Playback/utterance rate, 0.5–2.0. */
  rate: number;
  /** Output volume, 0–1. */
  volume: number;
  /** Auto-read AEGIS replies aloud in chat mode (Voice Mode always reads). */
  autoRead: boolean;
  /** Push-to-talk (hold to speak) vs. tap-to-toggle listening. */
  pushToTalk: boolean;
  /** Voice-activity detection: auto-send when the user stops speaking. */
  vad: boolean;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  rate: 1,
  volume: 1,
  autoRead: false,
  pushToTalk: false,
  vad: true,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Coerce arbitrary stored/posted JSON into a valid VoicePrefs (defaults + clamps). */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const r = (raw ?? {}) as Partial<Record<keyof VoicePrefs, unknown>>;
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    rate: clamp(num(r.rate, DEFAULT_VOICE_PREFS.rate), 0.5, 2),
    volume: clamp(num(r.volume, DEFAULT_VOICE_PREFS.volume), 0, 1),
    autoRead: bool(r.autoRead, DEFAULT_VOICE_PREFS.autoRead),
    pushToTalk: bool(r.pushToTalk, DEFAULT_VOICE_PREFS.pushToTalk),
    vad: bool(r.vad, DEFAULT_VOICE_PREFS.vad),
  };
}
