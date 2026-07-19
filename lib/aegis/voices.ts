/**
 * Aegis voice catalog — browser (Web Speech) voices only.
 *
 * A voice preference is a portable token:
 *   "browser"             — the standard German Web Speech voice (Google Deutsch
 *                           where available, else any de-* voice)
 *   "browser:<voiceURI>"  — a specific OS/browser voice (device-specific, best-effort)
 *   null / ""             — the Aegis default (the recommended voice)
 *
 * Speech is synthesized entirely on the device via the browser's built-in
 * speechSynthesis — no cloud TTS provider is involved. Pure + dependency-light
 * so it runs on client and server.
 */

export type VoiceProvider = 'browser';

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

export const BROWSER_VOICE_ID = 'browser';
export const BROWSER_VOICE_PREFIX = 'browser:';

/**
 * The default Aegis voice: the device's standard German Web Speech voice.
 * Specific device voices ("browser:<voiceURI>") are offered dynamically in the
 * settings UI, since the available set differs per OS/browser.
 */
export const DEFAULT_VOICE_ID = BROWSER_VOICE_ID;

export const AEGIS_VOICES: AegisVoice[] = [
  {
    id: BROWSER_VOICE_ID,
    provider: 'browser',
    name: 'Browser-Stimme (Standard)',
    language: 'de',
    recommended: true,
  },
];

/** German sample line used for voice previews. */
export const VOICE_SAMPLE_DE =
  'Guten Tag, ich bin AEGIS, Ihr KI-Regulatorik-Berater. So klinge ich.';

/** Accepts catalog ids, the generic/specific browser tokens, and null (= default). */
export function isValidVoiceId(id: string | null | undefined): boolean {
  if (id == null || id === '') return true;
  if (id === BROWSER_VOICE_ID || id.startsWith(BROWSER_VOICE_PREFIX)) return true;
  return AEGIS_VOICES.some((v) => v.id === id);
}

/**
 * Resolve a stored preference to a concrete voice token (null → default).
 * Legacy tokens from removed providers (e.g. "cartesia:<uuid>") resolve to the
 * default browser voice, so old accounts keep working after the cloud-TTS
 * removal without a data migration.
 */
export function resolveVoiceId(pref: string | null | undefined): string {
  if (!pref || pref.length === 0) return DEFAULT_VOICE_ID;
  return isValidVoiceId(pref) ? pref : DEFAULT_VOICE_ID;
}

export function voiceById(id: string): AegisVoice | undefined {
  return AEGIS_VOICES.find((v) => v.id === id);
}

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
