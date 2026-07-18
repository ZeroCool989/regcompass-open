'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getCartesiaVoiceId,
  getSelectedVoiceURI,
  isCartesiaVoice,
  resolveSelectedVoice,
} from '@/components/AegisVoicePicker';

// Module-singleton: only one utterance plays at a time across the whole UI.
// When a new TTS button starts playback we stop any previous one.
let activeUtteranceId: string | null = null;
// The Cartesia (Marlene) path plays an <audio> element instead of using
// speechSynthesis; track it (and any in-flight synth request) so stopAegisTts()
// can halt it too.
let activeAudio: HTMLAudioElement | null = null;
let activeAbort: AbortController | null = null;
const listeners = new Set<(activeId: string | null) => void>();

function setActive(id: string | null): void {
  activeUtteranceId = id;
  for (const l of listeners) l(id);
}

function teardownAudio(): void {
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {
      /* ignore */
    }
    activeAbort = null;
  }
  if (!activeAudio) return;
  const audio = activeAudio;
  activeAudio = null;
  try {
    audio.pause();
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.removeAttribute('src');
  } catch {
    /* ignore */
  }
}

function subscribe(cb: (activeId: string | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** True when the browser can stream-decode MP3 via MediaSource. */
function canStreamMp3(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaSource !== 'undefined' &&
    window.MediaSource.isTypeSupported('audio/mpeg')
  );
}

/**
 * Feed the MP3 response body into a MediaSource SourceBuffer chunk-by-chunk so
 * playback can start on the first chunk instead of waiting for the whole clip.
 * Appends are serialized through `updateend` since SourceBuffer rejects a new
 * append while one is in progress.
 */
function streamIntoAudio(audio: HTMLAudioElement, body: ReadableStream<Uint8Array>): void {
  const mediaSource = new MediaSource();
  audio.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener(
    'sourceopen',
    () => {
      let sb: SourceBuffer;
      try {
        sb = mediaSource.addSourceBuffer('audio/mpeg');
      } catch {
        return;
      }
      const reader = body.getReader();
      const queue: Uint8Array<ArrayBuffer>[] = [];
      let finished = false;

      const pump = () => {
        if (sb.updating) return;
        if (queue.length > 0) {
          try {
            sb.appendBuffer(queue.shift()!);
          } catch {
            /* QuotaExceeded etc. — drop; playback continues with what's buffered */
          }
          return;
        }
        if (finished && mediaSource.readyState === 'open') {
          try {
            mediaSource.endOfStream();
          } catch {
            /* ignore */
          }
        }
      };

      sb.addEventListener('updateend', pump);
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              pump();
              break;
            }
            if (value) {
              // Copy into an ArrayBuffer-backed view (appendBuffer rejects
              // SharedArrayBuffer-backed views in strict typings).
              queue.push(new Uint8Array(value));
              pump();
            }
          }
        } catch {
          finished = true;
        }
      })();
    },
    { once: true },
  );
}

export function stopAegisTts(): void {
  if (typeof window === 'undefined') return;
  teardownAudio();
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
  setActive(null);
}

/**
 * Strip everything that would sound terrible read aloud: markdown syntax,
 * citation IDs, code fences, tables, warning banners, headings. Keeps the
 * actual prose intact.
 */
function stripForSpeech(text: string): string {
  let out = text;
  // Drop tables: any block that contains pipes.
  out = out
    .split(/\r?\n\s*\r?\n/)
    .filter((block) => !/^\s*\|.*\|\s*$/m.test(block))
    .join('\n\n');
  // Drop warning banners (⚠️ Quelle: ...) entirely.
  out = out.replace(/⚠️[^\n]*\n[^\n]*/g, '');
  // Strip code fences and inline code.
  out = out.replace(/```[\s\S]*?```/g, '');
  out = out.replace(/`([^`\n]+)`/g, '$1');
  // Strip heading hashes.
  out = out.replace(/^#{1,6}\s+/gm, '');
  // Strip bold / italic markers.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  // Strip citation IDs like [R-XXXX-YYY].
  out = out.replace(/\[R-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/g, '');
  // Collapse multiple blank lines.
  out = out.replace(/\n{3,}/g, '\n\n');
  // List bullets → spoken pause.
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+\.\s+/gm, '');
  // Horizontal rules.
  out = out.replace(/^[-*_]{3,}\s*$/gm, '');
  return out.trim();
}

/**
 * Speak `text` with the browser's Web Speech voice (German fallback). Used both
 * for the browser-voice selection and as the graceful fallback when the
 * Cartesia cloud voice is unavailable (e.g. the API key hits its limit) — so
 * AEGIS keeps talking instead of going silent. Returns false if Web Speech
 * isn't available or there's nothing to say.
 */
function speakViaBrowser(text: string, ownerId: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const spoken = stripForSpeech(text);
  if (!spoken) return false;
  const u = new SpeechSynthesisUtterance(spoken);
  const v = resolveSelectedVoice(); // user's de voice, else a de-DE fallback
  u.lang = v?.lang ?? 'de-DE';
  if (v) u.voice = v;
  u.rate = 1.0;
  u.pitch = 1.0;
  u.onend = () => {
    if (activeUtteranceId === ownerId) setActive(null);
  };
  u.onerror = () => {
    if (activeUtteranceId === ownerId) setActive(null);
  };
  setActive(ownerId);
  try {
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    setActive(null);
    return false;
  }
}

export function AegisTtsButton({ text }: { text: string }) {
  // Stable id per mount — used to track which button "owns" the active
  // utterance so other instances can show themselves as stopped.
  const idRef = useRef<string>(`tts-${Math.random().toString(36).slice(2, 10)}`);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [active, setActiveLocal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setSupported(false);
      return;
    }
    // Web Speech (browser voices) OR the Cartesia path (just needs Audio).
    const hasWebSpeech =
      'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    setSupported(hasWebSpeech || typeof window.Audio !== 'undefined');
  }, []);

  // Subscribe to the global active-utterance pointer.
  useEffect(() => {
    return subscribe((activeId) => {
      setActiveLocal(activeId === idRef.current);
    });
  }, []);

  // Auto-stop when tab goes hidden — nothing more annoying than a TTS that
  // keeps reading in a background tab.
  useEffect(() => {
    if (!active) return;
    function onVis() {
      if (document.hidden) stopAegisTts();
    }
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [active]);

  // Cartesia path (KI-Stimmen): synthesize server-side (MP3) and play it.
  // Streams chunk-by-chunk via MediaSource so audio starts on the first chunk;
  // falls back to a full-buffer blob where MediaSource MP3 isn't supported.
  const playCartesia = useCallback(async (voiceId: string) => {
    const spoken = stripForSpeech(text);
    if (!spoken) return;
    const abort = new AbortController();
    activeAbort = abort;
    setActive(idRef.current);
    try {
      const res = await fetch('/api/aegis/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spoken, voiceId }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`TTS ${res.status}`);
      // A stop/restart may have superseded us while the request was in flight.
      if (activeAbort !== abort || activeUtteranceId !== idRef.current) return;

      const audio = new Audio();
      activeAudio = audio;
      audio.onended = () => {
        if (activeAudio === audio) stopAegisTts();
      };
      audio.onerror = () => {
        if (activeAudio === audio) stopAegisTts();
      };

      if (canStreamMp3()) {
        streamIntoAudio(audio, res.body);
        await audio.play();
      } else {
        // Fallback: download fully, then play.
        const blob = await res.blob();
        if (activeAudio !== audio) return; // superseded while downloading
        audio.src = URL.createObjectURL(blob);
        await audio.play();
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // user stopped us
      if (activeUtteranceId !== idRef.current) return;
      // Cartesia unavailable (API limit, quota, or outage) — fall back to the
      // browser voice so speech still works instead of going silent.
      teardownAudio(); // clear the failed audio/abort so its onerror won't fire
      if (!speakViaBrowser(text, idRef.current)) stopAegisTts();
    }
  }, [text]);

  const toggle = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (active) {
      stopAegisTts();
      return;
    }
    // Stop anything else currently playing (speech or audio) first.
    stopAegisTts();

    const selectedUri = getSelectedVoiceURI();
    if (isCartesiaVoice(selectedUri)) {
      const voiceId = getCartesiaVoiceId(selectedUri);
      if (voiceId) {
        void playCartesia(voiceId);
        return;
      }
    }

    speakViaBrowser(text, idRef.current);
  }, [active, text, playCartesia]);

  if (supported === null || supported === false) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      aria-label={active ? 'Vorlesen stoppen' : 'Antwort vorlesen'}
      title={active ? 'Vorlesen stoppen' : 'Antwort vorlesen'}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${
        active
          ? 'border-brand-primary text-brand-primary bg-brand-primary/10'
          : 'border-transparent text-text-secondary hover:text-brand-primary hover:border-brand-primary/40'
      }`}
    >
      {active ? (
        // Clear "stop" affordance while a voice is playing — click to halt.
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="currentColor"
          stroke="none"
          aria-hidden="true"
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      )}
    </button>
  );
}
