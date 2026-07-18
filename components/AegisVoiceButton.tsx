'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sendMessage as storeSendMessage,
  setInput as storeSetInput,
  type AegisMode,
} from '@/lib/aegis/client-store';

// Minimal subset of the Web Speech API surface we touch. The browser types
// vary (Chrome prefixes `webkitSpeechRecognition`); we keep this loose.
type SpeechRecognitionResultLite = {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): { readonly transcript: string };
  [index: number]: { readonly transcript: string };
};
type SpeechRecognitionResultListLite = {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLite;
  [index: number]: SpeechRecognitionResultLite;
};
type SpeechRecognitionEventLite = {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLite;
};
type SpeechRecognitionErrorEventLite = { readonly error: string };
type SpeechRecognitionLite = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLite) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLite) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLite;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type VoiceState = 'idle' | 'recording' | 'processing';

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={active ? 'text-brand-primary' : 'text-text-secondary'}
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
    </svg>
  );
}

function EqualizerBars({ phase }: { phase: VoiceState }) {
  const cls = (i: number) =>
    `aegis-voice-bar ${phase === 'recording' ? 'recording' : ''} ${phase === 'processing' ? 'processing' : ''}`.trim() +
    ` aegis-voice-bar-${i}`;
  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center gap-[2px] h-4"
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cls(i)} />
      ))}
    </span>
  );
}

type PermissionStatus = 'unknown' | 'granted' | 'denied';

// Lightweight surface for the value returned by navigator.permissions.query()
// — the lib.dom typings call this PermissionStatus too, which would collide.
type PermissionStatus_API = {
  state: 'granted' | 'denied' | 'prompt';
  onchange: ((e: Event) => void) | null;
};

type MicProbe =
  | { ok: true }
  | { ok: false; kind: 'no-api' | 'denied' | 'no-device' | 'hardware' | 'insecure' | 'other'; detail: string };

// Triggers the browser's microphone-permission prompt (first call only) and
// releases the stream immediately — we just need the permission, not audio.
async function probeMicrophone(): Promise<MicProbe> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, kind: 'no-api', detail: 'Browser unterstützt getUserMedia nicht.' };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return { ok: false, kind: 'denied', detail: msg };
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return { ok: false, kind: 'no-device', detail: msg };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return { ok: false, kind: 'hardware', detail: msg };
    }
    if (name === 'SecurityError') {
      return { ok: false, kind: 'insecure', detail: msg };
    }
    return { ok: false, kind: 'other', detail: msg };
  }
}

// Friendly German guidance for each failure mode.
function micErrorMessage(kind: Exclude<MicProbe, { ok: true }>['kind']): { title: string; body: string } {
  switch (kind) {
    case 'denied':
      return {
        title: 'Mikrofon ist blockiert',
        body: 'Chrome blockiert das Mikrofon für diese Seite. Klick auf das 🔒-Symbol links in der Adressleiste → "Mikrofon" → "Zulassen". Danach die Seite neu laden.',
      };
    case 'no-device':
      return {
        title: 'Kein Mikrofon gefunden',
        body: 'Der Browser findet kein Mikrofon. Schließ ein Mikrofon an oder prüf die Audio-Einstellungen deines Systems.',
      };
    case 'hardware':
      return {
        title: 'Mikrofon nicht verfügbar',
        body: 'Eine andere App nutzt das Mikrofon. Schließ sie und versuch es erneut.',
      };
    case 'insecure':
      return {
        title: 'Unsichere Verbindung',
        body: 'Mikrofon-Zugriff erfordert HTTPS oder localhost. Diese Seite läuft nicht auf einem sicheren Kontext.',
      };
    case 'no-api':
      return {
        title: 'Browser unterstützt kein Mikrofon',
        body: 'Versuche es mit Chrome, Edge oder Safari.',
      };
    case 'other':
      return {
        title: 'Mikrofon-Zugriff fehlgeschlagen',
        body: 'Unbekannter Fehler beim Zugriff auf das Mikrofon. Schau in die Browser-Konsole für Details.',
      };
  }
}

// Maps SpeechRecognition error codes to friendly German guidance.
function speechErrorMessage(error: string): { title: string; body: string } | null {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return {
        title: 'Spracherkennung blockiert',
        body: 'Chrome lässt die Spracherkennung nicht zu. Klick auf das 🔒-Symbol links in der Adressleiste → "Mikrofon" → "Zulassen". Danach die Seite neu laden.',
      };
    case 'audio-capture':
      return {
        title: 'Kein Audio',
        body: 'Der Browser konnte kein Audio aufnehmen. Prüf dein Mikrofon und versuch es erneut.',
      };
    case 'network':
      return {
        title: 'Netzwerkfehler',
        body: 'Die Spracherkennung konnte den Server nicht erreichen. Prüf deine Internetverbindung.',
      };
    case 'language-not-supported':
      return {
        title: 'Sprache nicht unterstützt',
        body: 'Die ausgewählte Sprache wird nicht unterstützt.',
      };
    case 'no-speech':
    case 'aborted':
      return null; // routine, don't surface
    default:
      return {
        title: 'Spracherkennung fehlgeschlagen',
        body: `Fehler: ${error}`,
      };
  }
}

export function AegisVoiceButton({
  mode,
  disabled = false,
}: {
  mode: AegisMode;
  disabled?: boolean;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<VoiceState>('idle');
  const [permission, setPermission] = useState<PermissionStatus>('unknown');
  const [hint, setHint] = useState<{ title: string; body: string } | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLite | null>(null);
  // Buffers the cumulative final transcript across one recording session.
  // (interim results are written to the input live but not stored here.)
  const finalTranscriptRef = useRef<string>('');
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  // Cleanup on unmount or when component goes away.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    };
  }, []);

  const showHint = useCallback((next: { title: string; body: string } | null) => {
    setHint(next);
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
    if (next) {
      // Permission/error hints stay longer so the user can read instructions.
      hintTimerRef.current = setTimeout(() => setHint(null), 12000);
    }
  }, []);

  // Watch for permission changes via the Permissions API. When the user grants
  // mic access from Chrome's site settings, this fires and clears the hint.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let cancelled = false;
    let status: PermissionStatus_API | null = null;
    void navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s as unknown as PermissionStatus_API;
        const apply = () => {
          if (cancelled || !status) return;
          if (status.state === 'granted') {
            setPermission('granted');
            setHint(null);
          } else if (status.state === 'denied') {
            setPermission('denied');
          }
        };
        apply();
        status.onchange = apply;
      })
      .catch(() => { /* Permissions API not available — fall back to getUserMedia probe */ });
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, []);

  const stopRecording = useCallback(
    (opts?: { send?: boolean }) => {
      const rec = recognitionRef.current;
      if (!rec) {
        setPhase('idle');
        return;
      }
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      setPhase('processing');
      // onend handler will finalise — but we also handle the send here so the
      // user sees immediate feedback (UI freezes for ~100 ms otherwise).
      const transcript = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      if (opts?.send && transcript.length >= 5) {
        void storeSendMessage(transcript, mode, { voice: true });
      }
      // Reset to idle shortly after — `processing` is mostly visual.
      window.setTimeout(() => setPhase('idle'), 250);
    },
    [mode],
  );

  const startRecording = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    // de-CH = Standard German as spoken in Switzerland (Swiss High German) —
    // better acoustic fit for Swiss users than de-DE. NOTE: the engine does
    // NOT understand Schweizerdeutsch dialect; users must speak Hochdeutsch.
    // Keep in sync with AegisVoiceMode (both recognition sites, finding F4).
    rec.lang = 'de-CH';
    rec.continuous = true;
    rec.interimResults = true;

    let interim = '';
    finalTranscriptRef.current = '';

    rec.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const chunk = result[0]?.transcript ?? '';
        if (result.isFinal) {
          finalTranscriptRef.current =
            (finalTranscriptRef.current + ' ' + chunk).trim();
        } else {
          interim += chunk;
        }
      }
      const combined = (finalTranscriptRef.current + ' ' + interim).trim();
      storeSetInput(combined);
    };

    rec.onerror = (e) => {
      // `no-speech` and `aborted` are routine — don't spam the console.
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[aegis voice] speech error:', e.error);
      }
      // If the engine reports the mic is blocked at the recognition layer,
      // surface it visibly and clear the cached permission so the next click
      // re-probes via getUserMedia.
      const friendly = speechErrorMessage(e.error);
      if (friendly) {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setPermission('denied');
        }
        showHint(friendly);
      }
      setPhase('idle');
      recognitionRef.current = null;
    };

    rec.onend = () => {
      // If we exited via user toggle this is already handled; otherwise
      // ensure the state resets so a fresh click can start a new session.
      if (recognitionRef.current === rec) {
        recognitionRef.current = null;
        setPhase((p) => (p === 'recording' ? 'idle' : p));
      }
    };

    recognitionRef.current = rec;
    setPhase('recording');
    try {
      rec.start();
    } catch (err) {
      // Calling start() twice on the same instance throws InvalidStateError.
      console.warn('[aegis voice] start failed:', err);
      recognitionRef.current = null;
      setPhase('idle');
    }
  }, []);

  // Stop on Esc.
  useEffect(() => {
    if (phase !== 'recording') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopRecording({ send: false });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, stopRecording]);

  const recording = phase === 'recording';
  const processing = phase === 'processing';

  const handleClick = useCallback(async () => {
    if (recording) {
      stopRecording({ send: true });
      return;
    }
    if (processing) return;

    // Always probe via getUserMedia when not known-granted. This is what
    // surfaces a previously-denied permission cleanly — Chrome won't re-prompt
    // for a denied origin, but the rejection tells us why so we can show
    // concrete instructions.
    if (permission !== 'granted') {
      const probe = await probeMicrophone();
      if (!probe.ok) {
        setPermission(probe.kind === 'denied' ? 'denied' : 'unknown');
        showHint(micErrorMessage(probe.kind));
        return;
      }
      setPermission('granted');
      showHint(null);
    }
    startRecording();
  }, [recording, processing, permission, stopRecording, startRecording, showHint]);

  if (supported === null) {
    // Pre-mount placeholder to avoid layout jump (matches button footprint).
    return <span className="w-12 h-12 shrink-0" aria-hidden="true" />;
  }
  if (!supported) {
    // Firefox (and a few others) ship no Web Speech Recognition API. Render
    // a disabled button so users know the feature exists and why it isn't
    // available, instead of mysteriously hiding it.
    const unsupportedLabel =
      'Spracheingabe wird in diesem Browser nicht unterstützt — bitte Chrome, Edge oder Safari verwenden';
    return (
      <button
        type="button"
        disabled
        aria-label={unsupportedLabel}
        title={unsupportedLabel}
        className="relative w-12 h-12 rounded-full flex items-center justify-center border border-border-brand bg-surface/30 text-text-secondary/40 shrink-0 cursor-not-allowed"
      >
        <MicIcon active={false} />
      </button>
    );
  }

  const label = recording
    ? 'Aufnahme stoppen und senden'
    : processing
      ? 'Verarbeite Sprache'
      : 'Spracheingabe starten';

  return (
    <div className="relative shrink-0">
      {hint && (
        <div
          role="status"
          className="absolute bottom-full mb-2 right-0 w-72 px-3 py-2.5 rounded-lg border border-brand-primary/40 bg-background/95 backdrop-blur shadow-lg text-[0.75rem] leading-snug text-foreground z-50"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden="true">🎤</span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold mb-0.5">{hint.title}</div>
              <div className="text-text-secondary">{hint.body}</div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleClick();
                  }}
                  className="text-[0.7rem] px-2 py-0.5 rounded border border-brand-primary/50 text-brand-primary hover:bg-brand-primary/10 transition-colors"
                >
                  Erneut versuchen
                </button>
                <button
                  type="button"
                  onClick={() => showHint(null)}
                  className="text-[0.7rem] px-2 py-0.5 rounded text-text-secondary hover:text-foreground transition-colors"
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        disabled={disabled || processing}
        aria-label={label}
        aria-pressed={recording}
        title={label}
        className={`relative w-12 h-12 rounded-full flex items-center justify-center border transition-colors ${
          recording
            ? 'border-red-500 bg-red-500/10 text-red-400'
            : processing
              ? 'border-brand-primary/60 bg-brand-primary/10 text-brand-primary'
              : 'border-border-brand bg-surface/60 text-text-secondary hover:border-brand-primary/60 hover:text-brand-primary'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {recording ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-red-500 animate-ping opacity-60"
          />
        ) : null}
        {recording || processing ? (
          <EqualizerBars phase={phase} />
        ) : (
          <MicIcon active={false} />
        )}
      </button>
    </div>
  );
}
