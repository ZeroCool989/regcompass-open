/**
 * Client-side read-aloud via the browser's built-in Web Speech voices
 * (Phase 4 Voice Mode + auto-read).
 *
 * speakText() plays `text` with the selected browser voice and returns a
 * controller you can stop(). If speechSynthesis is unavailable or errors,
 * onError fires and onEnd still resolves the state machine.
 *
 * ── Why primeSpeech() exists ───────────────────────────────────────────────
 * Voice Mode speaks the reply from an async callback that fires 30–120 s AFTER
 * the user's tap (the SSE `done` event). Browser autoplay policy — strict on
 * iOS Safari, and after activation expiry on Chrome/Edge — silently no-ops
 * speechSynthesis.speak() outside a user-gesture window. The fix: during the
 * tap that opens Voice Mode (and on every talk gesture), call primeSpeech() to
 * warm speechSynthesis with a gesture-initiated utterance, which unlocks later
 * async ones.
 *
 * Browser-only (uses speechSynthesis); call from client components.
 */

import { BROWSER_VOICE_PREFIX } from './voices';
import { resolveSelectedVoice, voiceByToken } from '@/components/AegisVoicePicker';

export interface SpeakOptions {
  /** Voice token: "browser" | "browser:<voiceURI>" | null (= saved selection). */
  voiceUri: string | null;
  rate?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  /** Fired when the browser voice fails. onEnd still follows. */
  onError?: () => void;
}

export interface SpeakController {
  stop(): void;
}

/**
 * Warm speechSynthesis for the rest of the session. MUST be called from inside
 * a user-gesture handler (e.g. the tap that opens Voice Mode). Idempotent and
 * cheap to call again on every tap.
 */
export function primeSpeech(): void {
  if (typeof window === 'undefined') return;
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
      window.speechSynthesis.cancel();
    }
  } catch {
    /* ignore */
  }
}

export function speakText(text: string, opts: SpeakOptions): SpeakController {
  let stopped = false;

  const finish = () => {
    if (!stopped) opts.onEnd?.();
  };

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    opts.onError?.();
    finish();
    return {
      stop() {
        stopped = true;
      },
    };
  }

  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // A specific per-user voice token ("browser:<voiceURI>") wins; otherwise the
  // device-local picker selection with its German fallback chain.
  const v =
    (opts.voiceUri?.startsWith(BROWSER_VOICE_PREFIX) ? voiceByToken(opts.voiceUri) : null) ??
    resolveSelectedVoice();
  u.lang = v?.lang ?? 'de-DE';
  if (v) u.voice = v;
  u.rate = opts.rate ?? 1;
  u.volume = opts.volume ?? 1;
  u.onend = finish;
  u.onerror = () => {
    opts.onError?.();
    finish();
  };
  opts.onStart?.();
  window.speechSynthesis.speak(u);

  return {
    stop() {
      stopped = true;
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}
