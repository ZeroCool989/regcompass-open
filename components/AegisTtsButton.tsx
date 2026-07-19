'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveSelectedVoice } from '@/components/AegisVoicePicker';

// Module-singleton: only one utterance plays at a time across the whole UI.
// When a new TTS button starts playback we stop any previous one.
let activeUtteranceId: string | null = null;
const listeners = new Set<(activeId: string | null) => void>();

function setActive(id: string | null): void {
  activeUtteranceId = id;
  for (const l of listeners) l(id);
}

function subscribe(cb: (activeId: string | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function stopAegisTts(): void {
  if (typeof window === 'undefined') return;
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
 * Speak `text` with the browser's Web Speech voice (the user's German pick,
 * else a de-DE fallback). Returns false if Web Speech isn't available or
 * there's nothing to say.
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
    setSupported('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window);
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

  const toggle = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (active) {
      stopAegisTts();
      return;
    }
    // Stop anything else currently playing first.
    stopAegisTts();
    speakViaBrowser(text, idRef.current);
  }, [active, text]);

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
