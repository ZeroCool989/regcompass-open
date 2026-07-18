'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AEGIS_VOICES,
  DEFAULT_VOICE_PREFS,
  resolveVoiceId,
  VOICE_SAMPLE_DE,
  type AegisVoice,
  type VoicePrefs,
} from '@/lib/aegis/voices';
import {
  getCartesiaVoiceId,
  isCartesiaVoice,
  resolveSelectedVoice,
  setSelectedVoiceURI,
} from '@/components/AegisVoicePicker';

const female = AEGIS_VOICES.filter((v) => v.provider === 'cartesia' && v.gender === 'feminine');
const male = AEGIS_VOICES.filter((v) => v.provider === 'cartesia' && v.gender === 'masculine');
const browser = AEGIS_VOICES.filter((v) => v.provider === 'browser');

export function VoiceSettings() {
  const [current, setCurrent] = useState<string | null>(null); // stored pref (null = default)
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<VoicePrefs>(DEFAULT_VOICE_PREFS);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/aegis/voice');
        if (res.ok) {
          const d = await res.json();
          setCurrent(d.voiceId ?? null);
          if (d.prefs) setPrefs(d.prefs);
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const savePrefs = useCallback(async (patch: Partial<VoicePrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      void fetch('/api/aegis/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: next }),
      }).catch(() => {});
      return next;
    });
  }, []);

  const resolved = resolveVoiceId(current);

  const select = useCallback(async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch('/api/aegis/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: id }),
      });
      if (!res.ok) {
        setError('Konnte nicht gespeichert werden.');
        return;
      }
      setCurrent(id);
      setSelectedVoiceURI(id); // sync the in-chat picker + TTS immediately
    } catch {
      setError('Netzwerkfehler.');
    } finally {
      setBusy(null);
    }
  }, []);

  const preview = useCallback(async (id: string) => {
    setPreviewing(id);
    try {
      audioRef.current?.pause();
    } catch {
      /* ignore */
    }
    const speakBrowser = () => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        setPreviewing(null);
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(VOICE_SAMPLE_DE);
      const v = resolveSelectedVoice();
      u.lang = v?.lang ?? 'de-DE';
      if (v) u.voice = v;
      u.onend = () => setPreviewing(null);
      window.speechSynthesis.speak(u);
    };
    try {
      if (isCartesiaVoice(id)) {
        const res = await fetch('/api/aegis/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: VOICE_SAMPLE_DE, voiceId: getCartesiaVoiceId(id) }),
        });
        if (res.ok) {
          const audio = new Audio(URL.createObjectURL(await res.blob()));
          audioRef.current = audio;
          audio.onended = () => setPreviewing(null);
          await audio.play();
          return;
        }
        speakBrowser(); // Cartesia unavailable (e.g. limit) → browser voice
        return;
      }
      speakBrowser();
    } catch {
      speakBrowser();
    }
  }, []);

  if (!loaded) return <p className="text-sm text-text-secondary">Lädt…</p>;

  const Row = ({ v }: { v: AegisVoice }) => {
    const isSel = resolved === v.id;
    return (
      <li className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-foreground">{v.name}</span>
          {v.recommended ? (
            <span className="text-[0.6rem] px-1.5 py-0.5 rounded border border-brand-primary/40 text-brand-primary">
              Empfohlen
            </span>
          ) : null}
          {isSel ? <span className="text-xs text-emerald-400">✓ aktiv</span> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => preview(v.id)}
            className="rounded-md border border-border-brand px-2 py-1 text-xs text-text-secondary hover:text-brand-primary hover:border-brand-primary/40 transition-colors"
            aria-label={`${v.name} vorhören`}
          >
            {previewing === v.id ? '▶ …' : '▶ Vorhören'}
          </button>
          <button
            type="button"
            disabled={busy === v.id || isSel}
            onClick={() => select(v.id)}
            className="rounded-md border border-brand-primary/50 bg-brand-primary/10 px-2.5 py-1 text-xs font-semibold text-brand-primary hover:bg-brand-primary/20 disabled:opacity-40 transition-colors"
          >
            {isSel ? 'Ausgewählt' : 'Wählen'}
          </button>
        </div>
      </li>
    );
  };

  const Group = ({ title, items }: { title: string; items: AegisVoice[] }) => (
    <section>
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      <ul className="divide-y divide-border-brand/40 rounded-lg border border-border-brand overflow-hidden">
        {items.map((v) => <Row key={v.id} v={v} />)}
      </ul>
    </section>
  );

  const Toggle = ({
    label,
    hint,
    value,
    onChange,
  }: {
    label: string;
    hint?: string;
    value: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <label className="flex items-start justify-between gap-3 px-4 py-2.5 cursor-pointer">
      <span>
        <span className="text-sm text-foreground">{label}</span>
        {hint ? <span className="block text-xs text-text-secondary/70">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--brand-primary,#00BFFF)]"
      />
    </label>
  );

  return (
    <div className="space-y-6">
      {error ? <div className="text-sm text-red-400">{error}</div> : null}
      <Group title="KI-Stimmen (weiblich)" items={female} />
      <Group title="KI-Stimmen (männlich)" items={male} />
      <Group title="Gerätestimme" items={browser} />

      <section>
        <h2 className="text-sm font-semibold mb-2">Wiedergabe & Steuerung</h2>
        <div className="rounded-lg border border-border-brand divide-y divide-border-brand/40">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">Sprechtempo</span>
              <span className="font-mono text-text-secondary">{prefs.rate.toFixed(2)}×</span>
            </div>
            <input
              type="range" min={0.5} max={2} step={0.05} value={prefs.rate}
              onChange={(e) => savePrefs({ rate: Number(e.target.value) })}
              className="w-full mt-1 accent-[var(--brand-primary,#00BFFF)]"
            />
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">Lautstärke</span>
              <span className="font-mono text-text-secondary">{Math.round(prefs.volume * 100)}%</span>
            </div>
            <input
              type="range" min={0} max={1} step={0.05} value={prefs.volume}
              onChange={(e) => savePrefs({ volume: Number(e.target.value) })}
              className="w-full mt-1 accent-[var(--brand-primary,#00BFFF)]"
            />
          </div>
          <Toggle
            label="Antworten automatisch vorlesen"
            hint="Im Chat AEGIS-Antworten direkt vorlesen (im Sprachmodus immer aktiv)."
            value={prefs.autoRead}
            onChange={(v) => savePrefs({ autoRead: v })}
          />
          <Toggle
            label="Push-to-Talk"
            hint="Orb zum Sprechen gedrückt halten statt antippen."
            value={prefs.pushToTalk}
            onChange={(v) => savePrefs({ pushToTalk: v })}
          />
          <Toggle
            label="Sprachaktivierung (VAD)"
            hint="Automatisch senden, sobald Sie aufhören zu sprechen."
            value={prefs.vad}
            onChange={(v) => savePrefs({ vad: v })}
          />
        </div>
      </section>
    </div>
  );
}
