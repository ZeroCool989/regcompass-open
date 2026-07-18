/**
 * Client-side TTS with graceful fallback (Phase 4 Voice Mode + auto-read).
 *
 * speakText() plays `text` in the selected voice and returns a controller you
 * can stop(). Cartesia (premium) is tried first; on ANY failure — API limit,
 * quota, outage, or a blocked autoplay — it falls back to the browser's German
 * Web Speech voice, so the user is never left in silence. If the browser voice
 * is also unavailable, onError fires and onEnd still resolves the state machine.
 *
 * ── Why primeSpeech() exists ───────────────────────────────────────────────
 * Voice Mode speaks the reply from an async callback that fires 30–120 s AFTER
 * the user's tap (the SSE `done` event). Browser autoplay policy — strict on
 * iOS Safari, and after activation expiry on Chrome/Edge — blocks
 * HTMLMediaElement.play() and speechSynthesis.speak() unless they happen in a
 * user-gesture window. A play() that far from the tap rejects with
 * NotAllowedError and (on iOS) speechSynthesis silently no-ops, so the orb
 * never speaks. The fix: during the tap that opens Voice Mode, call
 * primeSpeech() to "unlock" a single reusable <audio> element (and warm
 * speechSynthesis). Because the unlock is tied to that specific element, every
 * later clip MUST play through the same element — hence the shared singleton.
 *
 * Browser-only (uses Audio / speechSynthesis); call from client components.
 */

import { CARTESIA_PREFIX } from './voices';
import { vmark } from './voice-debug';
import { resolveSelectedVoice } from '@/components/AegisVoicePicker';

export interface SpeakOptions {
  /** Voice token: "cartesia:<uuid>" | "browser" | "browser:<uri>" | null. */
  voiceUri: string | null;
  rate?: number;
  volume?: number;
  onStart?: () => void;
  onEnd?: () => void;
  /** Fired when both Cartesia and the browser voice fail. onEnd still follows. */
  onError?: () => void;
}

export interface SpeakController {
  stop(): void;
}

// ── Shared, gesture-unlocked audio element ──────────────────────────────────
// One element for the whole session. iOS ties the autoplay unlock to a specific
// element instance, so unlock (primeSpeech) and every later clip must use it.
let sharedAudio: HTMLAudioElement | null = null;

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = 'auto';
  }
  return sharedAudio;
}

/** A ~1 ms silent WAV, built in-code so there is no risk of a malformed clip. */
function silentWavDataUri(): string {
  const sampleRate = 8000;
  const numSamples = 8; // 8-bit mono → 1 byte each
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128); // 8-bit silence
  let bin = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

/**
 * Unlock audio playback for the rest of the session. MUST be called from inside
 * a user-gesture handler (e.g. the tap that opens Voice Mode). Idempotent and
 * cheap to call again on every tap — it re-warms speechSynthesis too.
 */
export function primeSpeech(): void {
  if (typeof window === 'undefined') return;
  const el = getSharedAudio();
  if (el) {
    try {
      el.muted = false;
      el.src = silentWavDataUri();
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          el.pause();
          try {
            el.currentTime = 0;
          } catch {
            /* ignore */
          }
        }).catch(() => {
          /* gesture too weak / blocked — speakText still tries, then falls back */
        });
      }
    } catch {
      /* ignore */
    }
  }
  // Warm speechSynthesis: a gesture-initiated speak() unlocks later async ones.
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
  let usingShared = false;
  let objectUrl: string | null = null;
  const abort = new AbortController();

  const revoke = () => {
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      objectUrl = null;
    }
  };

  const finish = () => {
    revoke();
    if (!stopped) opts.onEnd?.();
  };

  const browserFallback = () => {
    if (stopped) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      opts.onError?.();
      finish();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = resolveSelectedVoice();
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
  };

  const useCartesia = !!opts.voiceUri && opts.voiceUri.startsWith(CARTESIA_PREFIX);
  if (useCartesia) {
    (async () => {
      try {
        vmark('ttsRequestedAt');
        const res = await fetch('/api/aegis/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voiceId: opts.voiceUri!.slice(CARTESIA_PREFIX.length) }),
          signal: abort.signal,
        });
        if (stopped) return;
        if (!res.ok) {
          browserFallback(); // limit/quota/outage → browser voice
          return;
        }
        const blob = await res.blob();
        if (stopped) return;
        vmark('ttsAudioReadyAt');

        const el = getSharedAudio();
        if (!el) {
          browserFallback();
          return;
        }
        usingShared = true;
        objectUrl = URL.createObjectURL(blob);
        el.src = objectUrl;
        el.muted = false;
        el.volume = opts.volume ?? 1;
        el.playbackRate = opts.rate ?? 1;
        el.onended = finish;
        el.onerror = finish;

        try {
          await el.play();
        } catch {
          // Autoplay still blocked (gesture expired / not primed) → browser voice.
          revoke();
          if (stopped) return;
          browserFallback();
          return;
        }
        if (stopped) {
          try {
            el.pause();
          } catch {
            /* ignore */
          }
          revoke();
          return;
        }
        opts.onStart?.();
      } catch (err) {
        revoke();
        if ((err as Error)?.name === 'AbortError' || stopped) return;
        browserFallback();
      }
    })();
  } else {
    browserFallback();
  }

  return {
    stop() {
      stopped = true;
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
      try {
        if (usingShared && sharedAudio) sharedAudio.pause();
      } catch {
        /* ignore */
      }
      revoke();
      try {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* ignore */
      }
    },
  };
}
