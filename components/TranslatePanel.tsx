'use client';

import { useEffect, useRef, useState } from 'react';
import { TRANSLATION_TARGETS } from '@/lib/translate/targets';

type QualityWarning = { type: string; message: string; detail?: string };

type DocStatus = {
  id: string;
  status: string;
  translationStatus?: string | null;
  qualityWarnings?: QualityWarning[] | null;
};

const LANG_LABEL: Record<string, string> = {
  DE: 'Deutsch', EN: 'Englisch', ES: 'Spanisch', FR: 'Französisch', IT: 'Italienisch',
  NL: 'Niederländisch', PL: 'Polnisch', PT: 'Portugiesisch', CS: 'Tschechisch', RO: 'Rumänisch',
  BG: 'Bulgarisch', HU: 'Ungarisch', EL: 'Griechisch', DA: 'Dänisch', SV: 'Schwedisch',
  FI: 'Finnisch', TR: 'Türkisch', UK: 'Ukrainisch', RU: 'Russisch', ET: 'Estnisch',
  LT: 'Litauisch', LV: 'Lettisch', SL: 'Slowenisch', SK: 'Slowakisch', HR: 'Kroatisch',
};
const langLabel = (c?: string | null) => (c ? LANG_LABEL[c.toUpperCase()] ?? c.toUpperCase() : 'unbekannt');

/**
 * AEGIS Translate panel for a RegulatoryDocument (Library / Regulatorik-News).
 * Detected language → DE/EN → progress → quality warnings → open / download.
 * Never curates the KB; the result is a machine-translated searchable document.
 */
export function TranslatePanel({
  documentId,
  originalLanguage,
  onOpenTranslation,
  bundled = false,
}: {
  documentId: string;
  originalLanguage?: string | null;
  onOpenTranslation?: (translationDocId: string) => void;
  /** True for a bundled library law (docs/source); uses the library translate endpoint. */
  bundled?: boolean;
}) {
  const translateUrl = bundled
    ? `/api/library/${documentId}/translate`
    : `/api/regulatory-documents/${documentId}/translate`;
  const [detected, setDetected] = useState<string | null>(originalLanguage ?? null);
  const [phase, setPhase] = useState<'idle' | 'translating' | 'done' | 'error'>('idle');
  const [target, setTarget] = useState<string | null>(null);
  const [pick, setPick] = useState('DE');
  const [translationId, setTranslationId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<QualityWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Lazily detect the language the first time the panel is shown (ingested docs
  // only; bundled library laws are German and have no detect endpoint).
  useEffect(() => {
    if (bundled || detected || originalLanguage) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/regulatory-documents/${documentId}/detect`, { method: 'POST' });
        if (!res.ok) return;
        const { language } = (await res.json()) as { language: string | null };
        if (active && language) setDetected(language);
      } catch {
        /* detection optional */
      }
    })();
    return () => { active = false; };
  }, [documentId, detected, originalLanguage, bundled]);

  async function translate(to: string) {
    setTarget(to);
    setPhase('translating');
    setError(null);
    try {
      const res = await fetch(translateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: to }),
      });
      if (res.status === 503) {
        setError('Übersetzung ist nicht konfiguriert (DEEPL_API_KEY fehlt).');
        setPhase('error');
        return;
      }
      if (!res.ok) {
        setError('Übersetzung konnte nicht gestartet werden.');
        setPhase('error');
        return;
      }
      const { documentId: tid, status } = (await res.json()) as { documentId: string; status: string };
      setTranslationId(tid);
      if (status === 'INGESTED') return void finish(tid);
      pollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/regulatory-documents?id=${tid}`);
          if (!s.ok) return;
          const { document } = (await s.json()) as { document: DocStatus | null };
          if (!document) return;
          if (document.status === 'INGESTED') { stopPoll(); finish(tid, document.qualityWarnings ?? []); }
          else if (document.status === 'FAILED') { stopPoll(); setError('Übersetzung fehlgeschlagen.'); setPhase('error'); }
        } catch { /* keep polling */ }
      }, 3000);
    } catch {
      setError('Übersetzung fehlgeschlagen.');
      setPhase('error');
    }
  }

  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }

  async function finish(tid: string, w?: QualityWarning[]) {
    if (w) setWarnings(w);
    else {
      try {
        const s = await fetch(`/api/regulatory-documents?id=${tid}`);
        const { document } = (await s.json()) as { document: DocStatus | null };
        setWarnings(document?.qualityWarnings ?? []);
      } catch { /* ignore */ }
    }
    setPhase('done');
  }

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden>🌐</span>
        <span className="font-medium text-foreground">AEGIS Übersetzen</span>
        <span className="text-xs text-text-secondary">Erkannte Sprache: {langLabel(detected)}</span>
      </div>

      {phase === 'idle' && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => translate('DE')} className="rounded-md bg-brand-primary/20 px-2.5 py-1 text-xs font-medium text-brand-primary hover:bg-brand-primary/30">🇩🇪 Deutsch</button>
          <button onClick={() => translate('EN')} className="rounded-md bg-brand-primary/20 px-2.5 py-1 text-xs font-medium text-brand-primary hover:bg-brand-primary/30">🇬🇧 English</button>
          <span className="text-text-secondary/60">·</span>
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-foreground"
            aria-label="Zielsprache"
          >
            {TRANSLATION_TARGETS.map((t) => (
              <option key={t.code} value={t.code}>{t.flag} {t.label}</option>
            ))}
          </select>
          <button onClick={() => translate(pick)} className="rounded-md bg-brand-primary/20 px-2.5 py-1 text-xs font-medium text-brand-primary hover:bg-brand-primary/30">Übersetzen</button>
        </div>
      )}

      {phase === 'translating' && (
        <p className="text-xs text-text-secondary">Übersetzung nach {langLabel(target)} läuft … (DeepL)</p>
      )}

      {phase === 'error' && <p className="text-xs text-red-300">{error}</p>}

      {phase === 'done' && translationId && (
        <div className="space-y-2">
          <p className="text-xs text-emerald-200">✅ Übersetzt nach {langLabel(target)} — maschinell (DeepL), nicht kuratierte KB.</p>
          {warnings.length > 0 && (
            <details className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1">
              <summary className="cursor-pointer text-xs text-amber-200">⚠️ {warnings.length} Übersetzungshinweis(e)</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.7rem] text-amber-100/90">
                {warnings.map((w, i) => <li key={i}>{w.message}{w.detail ? ` — ${w.detail}` : ''}</li>)}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {onOpenTranslation && (
              <button onClick={() => onOpenTranslation(translationId)} className="rounded-md bg-brand-primary/20 px-2.5 py-1 text-xs font-medium text-brand-primary hover:bg-brand-primary/30">Übersetzung öffnen</button>
            )}
            <a href={`/api/regulatory-documents/${translationId}/download?format=txt`} className="rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground hover:bg-white/20">TXT</a>
            <a href={`/api/regulatory-documents/${translationId}/download?format=md`} className="rounded-md bg-white/10 px-2.5 py-1 text-xs text-foreground hover:bg-white/20">Markdown</a>
          </div>
        </div>
      )}
    </div>
  );
}
