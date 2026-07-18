'use client';

import { useEffect, useRef, useState } from 'react';
import { CARTESIA_GERMAN_VOICES } from '@/lib/aegis/cartesia-voices';
import { BROWSER_VOICE_ID, resolveVoiceId, VOICE_SAMPLE_DE } from '@/lib/aegis/voices';

/**
 * Lets the user pick which voice the "Vorlesen" buttons use. Most options are
 * OS/browser voices (Web Speech `speechSynthesis`, e.g. macOS Anna, Markus,
 * Petra). A group of "KI-Stimmen" are Cartesia (sonic-3) German cloud voices
 * synthesized server-side via /api/aegis/tts; AegisTtsButton branches on them.
 * The choice is module-global + persisted to localStorage and shared by every
 * AegisTtsButton.
 */

const STORAGE_KEY = 'aegis-tts-voice';

/**
 * Cartesia voices are stored as the selected "voice URI" with this prefix
 * (e.g. `cartesia:9b4d08b6-...`). They are not real SpeechSynthesisVoices —
 * AegisTtsButton detects the prefix and routes playback through the TTS API,
 * passing the trailing voice id along.
 */
const CARTESIA_PREFIX = 'cartesia:';

export function cartesiaVoiceURI(id: string): string {
  return `${CARTESIA_PREFIX}${id}`;
}

export function isCartesiaVoice(uri: string | null): boolean {
  return typeof uri === 'string' && uri.startsWith(CARTESIA_PREFIX);
}

/** Extract the Cartesia voice id from a stored URI, or null if not a Cartesia voice. */
export function getCartesiaVoiceId(uri: string | null): string | null {
  return isCartesiaVoice(uri) ? uri!.slice(CARTESIA_PREFIX.length) : null;
}

let selectedVoiceURI: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function ensureLoaded(): void {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    selectedVoiceURI = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    /* private mode — stay in-memory */
  }
}

export function getSelectedVoiceURI(): string | null {
  ensureLoaded();
  return selectedVoiceURI;
}

export function setSelectedVoiceURI(uri: string | null): void {
  ensureLoaded();
  selectedVoiceURI = uri && uri.length > 0 ? uri : null;
  try {
    if (selectedVoiceURI) window.localStorage.setItem(STORAGE_KEY, selectedVoiceURI);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function subscribeVoice(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getGermanVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('de'));
}

/**
 * Resolve the SpeechSynthesisVoice the TTS button should use: the user's saved
 * choice if still available, else a de-DE / de-* fallback.
 */
export function resolveSelectedVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const uri = getSelectedVoiceURI();
  // A specific browser voice the user picked explicitly (not a cartesia/browser token).
  if (uri && uri !== BROWSER_VOICE_ID && !isCartesiaVoice(uri)) {
    const match = voices.find((v) => v.voiceURI === uri);
    if (match) return match;
  }
  // Standard browser voice = Google's German voice. The OS default ("device")
  // voice is often missing/silent, whereas Google Deutsch reliably produces
  // audio, so we prefer it; fall back to any de-DE / de-* voice if absent.
  const isDe = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith('de');
  return (
    voices.find((v) => isDe(v) && /google/i.test(v.name)) ??
    voices.find((v) => v.lang === 'de-DE') ??
    voices.find(isDe) ??
    null
  );
}

export function AegisVoicePicker() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selected, setSelected] = useState<string>('');
  const touchedRef = useRef(false);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const load = () => setVoices(getGermanVoices());
    load(); // getVoices() is often empty until voiceschanged fires
    window.speechSynthesis.addEventListener('voiceschanged', load);
    setSelected(getSelectedVoiceURI() ?? '');
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  // Per-user voice (Phase 4): the stored preference is the source of truth on
  // load. Seed the active selection from it (null → recommended default), unless
  // the user has already changed it this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/aegis/voice');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || touchedRef.current) return;
        setSelectedVoiceURI(resolveVoiceId(data.voiceId));
      } catch {
        /* fall back to localStorage / default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stay in sync if another instance changes the selection.
  useEffect(() => subscribeVoice(() => setSelected(getSelectedVoiceURI() ?? '')), []);

  function onChange(value: string) {
    const pref = value || BROWSER_VOICE_ID;
    touchedRef.current = true;
    setSelected(value);
    setSelectedVoiceURI(pref);
    void fetch('/api/aegis/voice', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId: pref }),
    }).catch(() => {});
  }

  function previewBrowser() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(VOICE_SAMPLE_DE);
    const v = resolveSelectedVoice();
    u.lang = v?.lang ?? 'de-DE';
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  }

  async function preview() {
    const uri = getSelectedVoiceURI();
    try {
      previewRef.current?.pause();
    } catch {
      /* ignore */
    }
    if (isCartesiaVoice(uri)) {
      try {
        const res = await fetch('/api/aegis/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: VOICE_SAMPLE_DE, voiceId: getCartesiaVoiceId(uri) }),
        });
        if (res.ok) {
          const audio = new Audio(URL.createObjectURL(await res.blob()));
          previewRef.current = audio;
          await audio.play();
          return;
        }
      } catch {
        /* fall through */
      }
      previewBrowser(); // Cartesia unavailable (e.g. limit) → browser voice
      return;
    }
    previewBrowser();
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      <label className="flex items-center gap-1.5 text-xs text-text-secondary">
        <span className="hidden sm:inline">Stimme</span>
        <select
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Aegis-Stimme wählen"
          title="Aegis-Stimme wählen"
          className="max-w-[10rem] rounded-md border border-border-brand bg-surface/60 px-1.5 py-1 text-xs text-foreground hover:border-brand-primary/50 focus:border-brand-primary focus:outline-none"
        >
          <optgroup label="KI-Stimmen (weiblich)">
            {CARTESIA_GERMAN_VOICES.filter((v) => v.gender === 'feminine').map((v) => (
              <option key={v.id} value={cartesiaVoiceURI(v.id)}>
                {v.name} (KI){cartesiaVoiceURI(v.id) === resolveVoiceId(null) ? ' ★' : ''}
              </option>
            ))}
          </optgroup>
          <optgroup label="KI-Stimmen (männlich)">
            {CARTESIA_GERMAN_VOICES.filter((v) => v.gender === 'masculine').map((v) => (
              <option key={v.id} value={cartesiaVoiceURI(v.id)}>
                {v.name} (KI){cartesiaVoiceURI(v.id) === resolveVoiceId(null) ? ' ★' : ''}
              </option>
            ))}
          </optgroup>
          <option value={BROWSER_VOICE_ID}>Browser-Stimme (Google)</option>
          {voices.length > 0 ? (
            <optgroup label="Browser-Stimmen">
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <button
        type="button"
        onClick={preview}
        aria-label="Stimme vorhören"
        title="Stimme vorhören"
        className="shrink-0 rounded-md border border-transparent px-1 py-0.5 text-text-secondary hover:text-brand-primary hover:border-brand-primary/40 transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
    </div>
  );
}
