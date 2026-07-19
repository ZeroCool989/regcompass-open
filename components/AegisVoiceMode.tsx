'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getServerSnapshot,
  getSnapshot,
  sendMessage as storeSendMessage,
  setVoiceSink,
  subscribe,
  type VoiceSink,
} from '@/lib/aegis/client-store';
import { AegisOrb } from '@/components/AegisOrb';
import AegisParticleOrb from '@/components/AegisParticleOrb';
import { AegisVoiceTimingOverlay } from '@/components/AegisVoiceTimingOverlay';
import { primeSpeech, speakText, type SpeakController } from '@/lib/aegis/speak';
import { vlog, vmark } from '@/lib/aegis/voice-debug';
import { DEFAULT_VOICE_PREFS, resolveVoiceId, type VoicePrefs } from '@/lib/aegis/voices';

// ── Minimal Web Speech recognition shim (browsers prefix webkit) ──
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
function getSR(): (new () => SR) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Phase = 'idle' | 'greeting' | 'listening' | 'thinking' | 'speaking';

const STATUS: Record<Phase, string> = {
  idle: 'Bereit · Wie kann ich dir helfen?',
  greeting: 'AEGIS begrüßt dich …',
  listening: 'Ich höre zu …',
  thinking: 'AEGIS denkt nach …',
  speaking: 'AEGIS spricht …',
};

/** Derive a usable first name from the stored username ("almir.dumisic" → "Almir"). */
function firstNameFrom(username: string | null): string | null {
  if (!username) return null;
  const token = username.trim().split(/[\s._-]+/)[0];
  if (!token) return null;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Map a SpeechRecognition error code to a user-facing German message. The
 * 'network' / 'service-not-allowed' codes are what non-Chrome Chromium browsers
 * (ChatGPT Atlas, Brave, Arc) report — they expose the API but have no working
 * Google STT backend, so we steer the user to Chrome rather than leave the mic
 * silently dead.
 */
function recErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Mikrofon blockiert. Bitte Mikrofon-Zugriff erlauben — oder Chrome verwenden.';
    case 'network':
    case 'start-failed':
      return 'Spracherkennung in diesem Browser nicht verfügbar. Bitte Chrome verwenden.';
    case 'no-speech':
      return 'Nichts gehört. Bitte tippe das Orb an und sprich erneut.';
    case 'audio-capture':
      return 'Kein Mikrofon gefunden. Bitte ein Mikrofon anschließen.';
    default:
      return 'Spracherkennung fehlgeschlagen. Bitte Chrome verwenden.';
  }
}

function buildGreeting(username: string | null): string {
  const first = firstNameFrom(username);
  // Address the user by name at the END of the greeting (folded into the closing
  // question), mirroring the per-answer name directive — not a canned "Hallo
  // <Name>" opener. Falls back to the name-less closer when no name is known.
  const closer = first
    ? `Wie kann ich dir weiterhelfen, ${first}?`
    : 'Wie kann ich dir weiterhelfen?';
  return `Hallo. Ich bin Aegis, dein KI-Agent rund um AI und IT Compliance. ${closer}`;
}

/**
 * Wait this long after Aegis stops speaking before reopening the mic. On a
 * laptop where the mic and speakers are the same device, the speaker output
 * needs a beat to die down — reopening instantly lets the recognizer capture
 * Aegis's own echo (or its echo-canceller suppress the user's voice), which is
 * why recognition is flaky on the built-in mic but fine on a headset. Harmless
 * on a headset, where there is no acoustic loop.
 */
const MIC_REOPEN_DELAY_MS = 450;

/**
 * Voice Mode. Two presentations share ALL the conversation logic below
 * (greeting, STT, streamed speech queue, barge-in, mic reopen):
 *  - 'fullscreen' (default): the immersive overlay — used by the header button.
 *  - 'inline': a compact strip that lives in the chat composer, so the chat log
 *    stays visible and voice turns show as normal text messages (they already
 *    flow through the shared store via sendMessage({ voice: true })).
 */
export function AegisVoiceMode({
  onClose,
  variant = 'fullscreen',
}: {
  onClose: () => void;
  variant?: 'fullscreen' | 'inline';
}) {
  const store = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [greeting, setGreeting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false); // default OFF
  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULT_VOICE_PREFS);
  const [voiceUri, setVoiceUri] = useState<string | null>(null);
  const [srSupported, setSrSupported] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);
  // Set when a reply could not be auto-played (autoplay blocked / TTS failed),
  // so we can offer a tap-to-play button. Holds the spoken text + message id.
  const [pendingReply, setPendingReply] = useState<{ id: string; text: string } | null>(null);

  const recRef = useRef<SR | null>(null);
  const finalRef = useRef('');
  const speakerRef = useRef<SpeakController | null>(null);
  const lastSpokenRef = useRef<string | null>(null);
  const greetedRef = useRef(false);
  const autoListenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedRef = useRef(false);
  const prefsRef = useRef<VoicePrefs>(DEFAULT_VOICE_PREFS);
  const usernameRef = useRef<string | null>(null);
  const voiceUriRef = useRef<string | null>(null);
  mutedRef.current = muted;
  prefsRef.current = prefs;

  // ── Phase 1: streamed sentence speech queue ──────────────────────────────
  // The store hands us complete sentences as they stream from the LLM; we play
  // them one at a time through the existing speakText so audio starts on the
  // first sentence instead of after the whole `done` event.
  const speechQueueRef = useRef<string[]>([]);
  const queueActiveRef = useRef(false); // a clip is currently playing
  const streamingSpokeRef = useRef(false); // ≥1 sentence queued this turn
  const streamCompleteRef = useRef(false); // `done` flushed → drain finalizes
  const firstClipStartedRef = useRef(false); // gates the speakingStartedAt mark
  const anyClipStartedRef = useRef(false); // audio actually played this turn

  // Load voice + prefs + username (for the greeting). Declared before the
  // auto-read effect, so it runs first on mount — which lets us mark any reply
  // already on screen as "spoken" before auto-read can fire, so only NEW
  // replies are spoken aloud (not whatever was left from a prior text chat).
  useEffect(() => {
    const msgs = getSnapshot().messages;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'aegis') lastSpokenRef.current = last.id;

    vlog('voice mode opened');
    setSrSupported(getSR() != null);
    (async () => {
      try {
        const res = await fetch('/api/aegis/voice');
        if (res.ok) {
          const d = await res.json();
          setPrefs(d.prefs ?? DEFAULT_VOICE_PREFS);
          setVoiceUri(d.resolved ?? resolveVoiceId(null));
        } else {
          setVoiceUri(resolveVoiceId(null));
        }
      } catch {
        setVoiceUri(resolveVoiceId(null));
      }
      try {
        const meRes = await fetch('/api/auth/me');
        if (meRes.ok) {
          const me = await meRes.json();
          usernameRef.current = me?.user?.username ?? null;
        }
      } catch {
        /* greeting falls back to the name-less variant */
      }
    })();
  }, []);

  const phase: Phase = greeting
    ? 'greeting'
    : speaking
      ? 'speaking'
      : store.isLoading
        ? 'thinking'
        : listening
          ? 'listening'
          : 'idle';
  const orbState =
    phase === 'thinking' ? 'thinking' : phase === 'speaking' || phase === 'greeting' ? 'speaking' : 'idle';

  // Keep a ref copy of the resolved voice so the streamed-speech queue (whose
  // callbacks are stable) always reads the current voice without re-registering.
  useEffect(() => {
    voiceUriRef.current = voiceUri;
  }, [voiceUri]);

  // Stop any in-flight speech AND drop every queued sentence. The single
  // "stop everything spoken" entry point — used for barge-in, mute, unmount.
  const clearQueueAndStop = useCallback(() => {
    speechQueueRef.current = [];
    queueActiveRef.current = false;
    firstClipStartedRef.current = false;
    speakerRef.current?.stop();
  }, []);

  const stopListening = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }, []);

  // Stable identity (reads live prefs via ref) so the greeting's onEnd can call
  // it without capturing a stale push-to-talk value.
  const startListening = useCallback(() => {
    const Ctor = getSR();
    if (!Ctor) {
      setSrSupported(false);
      return;
    }
    // A manual tap pre-empts any pending post-speech mic reopen.
    if (autoListenTimerRef.current != null) {
      clearTimeout(autoListenTimerRef.current);
      autoListenTimerRef.current = null;
    }
    // Re-arm the gesture-bound audio unlock. The reply is spoken from an async
    // SSE callback 30–120 s later — long past the tap that opened Voice Mode —
    // so without re-priming on each talk gesture the shared <audio> element can
    // lose its autoplay grant and the reply plays silently. Idempotent + cheap.
    primeSpeech();
    // Stop any speech (and drop the queued sentences) before we listen — barge-in.
    clearQueueAndStop();
    setSpeaking(false);
    setGreeting(false);
    finalRef.current = '';
    const rec = new Ctor();
    // de-CH — keep in sync with AegisVoiceButton (both recognition sites, F4).
    rec.lang = 'de-CH';
    rec.continuous = prefsRef.current.pushToTalk; // hold-to-talk keeps the mic open
    rec.interimResults = true;
    rec.onresult = (e) => {
      let finalText = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
      }
      if (finalText) finalRef.current = finalText;
    };
    rec.onerror = (e) => {
      // Browsers built on Chromium that aren't Google Chrome (e.g. ChatGPT
      // Atlas, Brave, Arc) expose webkitSpeechRecognition but have no working
      // STT backend — start() then fires 'network' / 'service-not-allowed'
      // immediately. Surface it instead of failing into a silent dead mic.
      vlog('recognition error', e?.error ?? 'unknown');
      setRecError(recErrorMessage(e?.error));
      setListening(false);
    };
    rec.onend = () => {
      setListening(false);
      const text = finalRef.current.trim();
      finalRef.current = '';
      vmark('finalTranscriptAt');
      vlog('transcript received', JSON.stringify(text));
      if (text.length > 0) {
        vlog('message sent');
        void storeSendMessage(text, undefined, { voice: true });
      }
    };
    recRef.current = rec;
    setRecError(null);
    setListening(true);
    vmark('listeningStartedAt');
    vlog('listening started');
    try {
      rec.start();
    } catch {
      // start() throws if mic permission isn't granted yet (needs a real tap),
      // or if the engine has no usable STT backend (non-Chrome Chromium).
      vlog('recognition start failed');
      setRecError(recErrorMessage('start-failed'));
      setListening(false);
    }
  }, [clearQueueAndStop]);

  // After the greeting (or as a deliberate hands-free kick-off), open the mic —
  // but only in tap-to-talk; hold-to-talk waits for the user to hold the orb.
  const autoListen = useCallback(() => {
    if (prefsRef.current.pushToTalk) return;
    if (!getSR()) return;
    startListening();
  }, [startListening]);

  // Same as autoListen, but waits MIC_REOPEN_DELAY_MS so the speaker output can
  // die down first — used after Aegis speaks so the built-in mic doesn't capture
  // the tail of its own voice. A manual tap (startListening) cancels the timer.
  const scheduleAutoListen = useCallback(() => {
    if (autoListenTimerRef.current != null) clearTimeout(autoListenTimerRef.current);
    autoListenTimerRef.current = setTimeout(() => {
      autoListenTimerRef.current = null;
      autoListen();
    }, MIC_REOPEN_DELAY_MS);
  }, [autoListen]);

  // Last streamed clip finished AND `done` has flushed → close out the turn:
  // stop the speaking state and reopen the mic, exactly like the old onEnd path.
  const finalizeStreamedTurn = useCallback(() => {
    streamCompleteRef.current = false;
    firstClipStartedRef.current = false;
    vmark('speakingFinishedAt');
    setSpeaking(false);
    scheduleAutoListen();
  }, [scheduleAutoListen]);

  // Play the next queued sentence; recurse on end. Named function expression so
  // the recursion is independent of the memoised identity (no self-dependency).
  const playNextInQueue = useCallback(function playNext(): void {
    const next = speechQueueRef.current.shift();
    if (next === undefined) {
      queueActiveRef.current = false;
      if (streamCompleteRef.current) finalizeStreamedTurn();
      return;
    }
    queueActiveRef.current = true;
    speakerRef.current?.stop();
    speakerRef.current = speakText(next, {
      voiceUri: voiceUriRef.current,
      rate: prefsRef.current.rate,
      volume: prefsRef.current.volume,
      onStart: () => {
        anyClipStartedRef.current = true;
        setPendingReply(null);
        setSpeaking(true);
        if (!firstClipStartedRef.current) {
          firstClipStartedRef.current = true;
          vmark('speakingStartedAt'); // first audio of the turn
        }
      },
      onEnd: () => playNext(),
      onError: () => {
        // The browser voice failed for this clip.
        if (!anyClipStartedRef.current) {
          // Nothing has played at all (autoplay blocked) — fall back to the
          // existing tap-to-play prompt with the full reply.
          const msgs = getSnapshot().messages;
          const lastMsg = msgs[msgs.length - 1];
          speechQueueRef.current = [];
          queueActiveRef.current = false;
          streamCompleteRef.current = false;
          setSpeaking(false);
          if (lastMsg && lastMsg.role === 'aegis') {
            setPendingReply({ id: lastMsg.id, text: stripForVoice(lastMsg.content) });
          }
          return;
        }
        playNext(); // mid-queue glitch after audio already played — keep going
      },
    });
  }, [finalizeStreamedTurn]);

  // Clean a streamed sentence and enqueue it; start playback if idle. Returns
  // false when nothing speakable was enqueued (muted, or empty after cleanup).
  const enqueueSentence = useCallback(
    (raw: string): boolean => {
      if (mutedRef.current) return false;
      const spoken = stripForVoice(raw);
      if (!spoken) return false;
      speechQueueRef.current.push(spoken);
      streamingSpokeRef.current = true;
      if (!queueActiveRef.current) playNextInQueue();
      return true;
    },
    [playNextInQueue],
  );

  // Register the streamed-speech sink with the store for this Voice Mode session.
  // Callbacks are stable (read live values via refs), so this registers once.
  useEffect(() => {
    const sink: VoiceSink = {
      onSentence: (raw) => {
        enqueueSentence(raw);
      },
      onRetract: () => {
        // Streamed text was withdrawn — stop, clear, and let the `done` path
        // (or the next stream) handle the authoritative answer.
        streamingSpokeRef.current = false;
        streamCompleteRef.current = false;
        clearQueueAndStop();
      },
      onComplete: (rest) => {
        streamCompleteRef.current = true;
        const added = enqueueSentence(rest);
        if (!streamingSpokeRef.current) {
          // Nothing streamed this turn (muted / no sentences) — defer entirely
          // to the existing done-based auto-read effect. Behaviour unchanged.
          streamCompleteRef.current = false;
          return;
        }
        // Everything already drained before `done` arrived → finalize now.
        if (!added && !queueActiveRef.current) finalizeStreamedTurn();
      },
    };
    setVoiceSink(sink);
    return () => setVoiceSink(null);
  }, [enqueueSentence, clearQueueAndStop, finalizeStreamedTurn]);

  // ── Greeting: play once per Voice Mode session, then start listening. ──
  // Gated on voiceUri so the greeting speaks with the user's selected voice.
  useEffect(() => {
    if (greetedRef.current) return;
    if (voiceUri === null) return; // wait until the selected voice is resolved
    greetedRef.current = true;
    if (mutedRef.current) {
      vlog('greeting skipped (muted)');
      autoListen();
      return;
    }
    const text = buildGreeting(usernameRef.current);
    vlog('greeting started');
    setGreeting(true);
    speakerRef.current?.stop();
    speakerRef.current = speakText(text, {
      voiceUri,
      rate: prefs.rate,
      volume: prefs.volume,
      onStart: () => vlog('greeting speaking started'),
      onEnd: () => {
        vlog('greeting completed');
        setGreeting(false);
        scheduleAutoListen();
      },
      onError: () => {
        vlog('greeting tts error');
        setGreeting(false);
        autoListen();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceUri]);

  // Auto-read new AEGIS replies (Voice Mode always reads, unless muted).
  useEffect(() => {
    if (store.isLoading) return;
    if (greeting) return; // never step on the greeting
    const last = store.messages[store.messages.length - 1];
    if (!last || last.role !== 'aegis') return;
    if (lastSpokenRef.current === last.id) return;
    lastSpokenRef.current = last.id;
    vlog('assistant response completed', last.id);
    // Phase 1: if this answer was already spoken sentence-by-sentence from the
    // token stream, the queue owns playback and the mic reopen — do NOT read the
    // whole message again. Streaming consumed; reset for the next turn.
    if (streamingSpokeRef.current) {
      streamingSpokeRef.current = false;
      vlog('auto-read skipped (already streamed)');
      return;
    }
    if (mutedRef.current) {
      vlog('auto-read skipped (muted)');
      return;
    }
    const spoken = stripForVoice(last.content);
    speakerRef.current?.stop();
    vlog('speakText() called', { voiceUri });
    speakerRef.current = speakText(spoken, {
      voiceUri,
      rate: prefs.rate,
      volume: prefs.volume,
      onStart: () => {
        vmark('speakingStartedAt');
        vlog('speaking started');
        setPendingReply(null); // playback succeeded — hide any tap-to-play prompt
        setSpeaking(true);
      },
      onEnd: () => {
        vmark('speakingFinishedAt');
        vlog('speaking completed');
        setSpeaking(false);
        // Conversation flow (Part 7): once Aegis finishes speaking, reopen the
        // mic so the user can ask a follow-up without tapping. Tap-to-talk only;
        // hold-to-talk and blocked SR fall back to a visible idle/mic prompt.
        // Delayed so the speaker tail doesn't bleed into the built-in mic.
        scheduleAutoListen();
      },
      onError: () => {
        // Autoplay blocked or TTS unavailable: don't leave the user in silence —
        // offer a tap-to-play button (a fresh gesture always unlocks playback).
        vlog('speaking error (browser voice failed)');
        setSpeaking(false);
        setPendingReply({ id: last.id, text: spoken });
        autoListen();
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.messages, store.isLoading, voiceUri, prefs.rate, prefs.volume]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (autoListenTimerRef.current != null) {
        clearTimeout(autoListenTimerRef.current);
        autoListenTimerRef.current = null;
      }
      try {
        recRef.current?.abort();
      } catch {
        /* ignore */
      }
      clearQueueAndStop();
    };
  }, [clearQueueAndStop]);

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      if (next) {
        clearQueueAndStop();
        setSpeaking(false);
        setGreeting(false);
      }
      return next;
    });
  }

  // Tap-to-play the last reply when autoplay blocked it. Runs inside a real
  // user gesture, so the shared audio element is guaranteed to be unlocked.
  const playPending = useCallback(() => {
    if (!pendingReply) return;
    primeSpeech();
    speakerRef.current?.stop();
    speakerRef.current = speakText(pendingReply.text, {
      voiceUri,
      rate: prefsRef.current.rate,
      volume: prefsRef.current.volume,
      onStart: () => {
        setPendingReply(null);
        setSpeaking(true);
      },
      onEnd: () => {
        setSpeaking(false);
        scheduleAutoListen();
      },
      onError: () => setSpeaking(false), // keep the button so the user can retry
    });
  }, [pendingReply, voiceUri, scheduleAutoListen]);

  // Push-to-talk: hold the orb. Tap-to-talk: click toggles.
  const orbPointerDown = prefs.pushToTalk ? () => startListening() : undefined;
  const orbPointerUp = prefs.pushToTalk ? () => stopListening() : undefined;
  const orbClick = !prefs.pushToTalk
    ? () => (listening ? stopListening() : startListening())
    : undefined;

  // ── Inline presentation: a compact strip for the chat composer. Same logic,
  // no fullscreen takeover — the chat log (incl. these voice turns) stays in view.
  if (variant === 'inline') {
    return (
      <div className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-brand-primary/40 bg-brand-primary/5 px-3 py-2">
        <div
          className="relative h-10 w-10 shrink-0"
          onPointerDown={orbPointerDown}
          onPointerUp={orbPointerUp}
          onClick={orbClick}
          role="button"
          tabIndex={0}
          aria-label={prefs.pushToTalk ? 'Zum Sprechen halten' : 'Zum Sprechen tippen'}
          style={{ cursor: 'pointer' }}
        >
          {/* The exact fullscreen orb (WebGL ring + eq/network overlays) rendered
              at native size and scaled down, so the ring, the equalizer bars (fixed
              5px each) and the listening pulse keep their fullscreen proportions
              instead of overflowing the 40px strip. Absolutely positioned so the
              200px source box never affects the 40px footprint or the strip. */}
          <div
            className={`absolute left-1/2 top-1/2 rounded-full ${phase === 'listening' ? 'aegis-listening-ring' : ''}`}
            style={{ width: 200, height: 200, transform: 'translate(-50%, -50%) scale(0.2)' }}
          >
            <AegisParticleOrb
              state={orbState}
              className={`aegis-orb-wrap aegis-orb-wrap-${orbState} h-full w-full rounded-full`}
            />
          </div>
        </div>
        <span
          className={`min-w-0 flex-1 truncate text-sm ${recError ? 'text-amber-400' : 'text-text-secondary'}`}
        >
          {!srSupported
            ? 'Spracherkennung nur in Chrome verfügbar.'
            : recError ?? STATUS[phase]}
        </span>
        {pendingReply ? (
          <button
            type="button"
            onClick={playPending}
            title="Antwort vorlesen"
            className="shrink-0 rounded-full border border-brand-primary/60 bg-brand-primary/10 px-2 py-1 text-sm text-brand-primary hover:bg-brand-primary/20 transition-colors"
          >
            🔊
          </button>
        ) : null}
        {!prefs.pushToTalk ? (
          <button
            type="button"
            onClick={() => (listening ? stopListening() : startListening())}
            disabled={!srSupported}
            aria-label={listening ? 'Aufnahme stoppen' : 'Sprechen'}
            title={listening ? 'Aufnahme stoppen' : 'Sprechen'}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition-colors disabled:opacity-40 ${
              listening
                ? 'border-brand-primary text-brand-primary bg-brand-primary/15'
                : 'border-border-brand text-text-secondary hover:border-brand-primary/60'
            }`}
          >
            🎤
          </button>
        ) : null}
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          title={muted ? 'Ton an' : 'Ton aus'}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-base transition-colors ${
            muted
              ? 'border-red-500/50 text-red-400 bg-red-500/10'
              : 'border-border-brand text-text-secondary hover:text-brand-primary'
          }`}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Sprachmodus beenden"
          title="Sprachmodus beenden"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border-brand text-text-secondary hover:text-foreground transition-colors"
        >
          ✕
        </button>
        <AegisVoiceTimingOverlay />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-text-secondary hover:text-foreground transition-colors"
        >
          ✕ Beenden
        </button>
        <span className="text-xs font-mono uppercase tracking-wider text-text-secondary">
          AEGIS · Sprachmodus
        </span>
        <button
          type="button"
          onClick={() => setShowTranscript((v) => !v)}
          className="text-sm text-text-secondary hover:text-brand-primary transition-colors"
        >
          {showTranscript ? 'Transkript ausblenden' : 'Transkript anzeigen'}
        </button>
      </div>

      {/* Orb stage */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
        <div
          className={`relative rounded-full transition-shadow ${
            phase === 'listening' ? 'aegis-listening-ring' : ''
          }`}
          onPointerDown={orbPointerDown}
          onPointerUp={orbPointerUp}
          onClick={orbClick}
          role="button"
          tabIndex={0}
          aria-label={prefs.pushToTalk ? 'Zum Sprechen halten' : 'Zum Sprechen tippen'}
          style={{ cursor: 'pointer' }}
        >
          <AegisOrb state={orbState} size="lg" />
        </div>
        <p
          className={`text-base font-medium text-center min-h-[1.5rem] ${
            recError ? 'text-amber-400' : 'text-foreground'
          }`}
        >
          {!srSupported
            ? 'Spracherkennung wird von diesem Browser nicht unterstützt.'
            : recError ?? STATUS[phase]}
        </p>
        {prefs.pushToTalk && phase !== 'greeting' ? (
          <p className="text-xs text-text-secondary/60">Orb gedrückt halten zum Sprechen</p>
        ) : null}
        {pendingReply ? (
          <button
            type="button"
            onClick={playPending}
            className="flex items-center gap-2 rounded-full border border-brand-primary/60 bg-brand-primary/10 px-4 py-2 text-sm font-medium text-brand-primary hover:bg-brand-primary/20 transition-colors"
          >
            🔊 Antwort vorlesen
          </button>
        ) : null}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 pb-10">
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          title={muted ? 'Ton an' : 'Ton aus'}
          className={`flex h-12 w-12 items-center justify-center rounded-full border transition-colors ${
            muted
              ? 'border-red-500/50 text-red-400 bg-red-500/10'
              : 'border-border-brand text-text-secondary hover:text-brand-primary'
          }`}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        {!prefs.pushToTalk ? (
          <button
            type="button"
            onClick={() => (listening ? stopListening() : startListening())}
            disabled={!srSupported}
            className={`flex h-16 w-16 items-center justify-center rounded-full border-2 text-xl transition-colors disabled:opacity-40 ${
              listening
                ? 'border-brand-primary text-brand-primary bg-brand-primary/15'
                : 'border-border-brand text-text-secondary hover:border-brand-primary/60'
            }`}
            aria-label={listening ? 'Aufnahme stoppen' : 'Sprechen'}
          >
            🎤
          </button>
        ) : null}
        <a
          href="/account/voice"
          title="Spracheinstellungen"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-border-brand text-text-secondary hover:text-brand-primary transition-colors no-underline"
        >
          ⚙
        </a>
      </div>

      {/* Transcript (default hidden) */}
      {showTranscript ? (
        <div className="border-t border-border-brand bg-surface/40 max-h-[40vh] overflow-y-auto px-6 py-4">
          <div className="max-w-2xl mx-auto space-y-3">
            {store.messages.length === 0 ? (
              <p className="text-sm text-text-secondary">Noch keine Nachrichten.</p>
            ) : (
              store.messages.map((m) => (
                <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
                  <span className="text-[0.65rem] uppercase tracking-wide text-text-secondary/60">
                    {m.role === 'user' ? 'Sie' : m.role === 'aegis' ? 'AEGIS' : 'Fehler'}
                  </span>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{m.content}</p>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {/* Phase 0: developer latency overlay. Self-gates on the aegis-voice-debug
          flag — renders nothing (and records nothing) for real users. */}
      <AegisVoiceTimingOverlay />
    </div>
  );
}

/**
 * Text cleanup for spoken output. Citations stay in the stored message (and the
 * transcript), but must never be read aloud — neither the [R-...] IDs nor a
 * trailing "Quellen:" list. Also strips markdown markers and symbol/emoji noise
 * (e.g. ⚠️) that TTS would otherwise mispronounce.
 */
function stripForVoice(text: string): string {
  return text
    // Trailing "Quellen:" / "Sources:" section — citations live inline only.
    .replace(/\n+\s*(Quellen|Sources)\s*:[\s\S]*$/i, '')
    // Citation IDs like [R-DORA-003].
    .replace(/\[R-[A-Z0-9]+(?:-[A-Z0-9]+)+\]/g, '')
    // Markdown emphasis / heading / code markers.
    .replace(/[#*`_]+/g, '')
    // Symbol & emoji ranges (Misc Technical, Dingbats, variation selector, emoji)
    // e.g. the KB-fallback warning glyph, which TTS would otherwise mispronounce.
    .replace(/[⌀-➿⬀-⯿️\u{1F000}-\u{1FAFF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
