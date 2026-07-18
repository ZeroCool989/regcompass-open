'use client';

import { useState } from 'react';

/**
 * Export menu — downloads the current conversation's assessment as a
 * from-scratch deliverable (Excel / Word / PDF) via POST /api/aegis/export.
 * Disabled until a conversation exists; errors surface as a small German note.
 */
export function AegisExportMenu({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!conversationId) return null;

  const run = async (format: 'xlsx' | 'docx' | 'pdf') => {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch('/api/aegis/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, conversationId }),
      });
      const data = (await res.json()) as { downloadId?: string; message?: string };
      if (!res.ok || !data.downloadId) {
        setError(data.message ?? 'Export fehlgeschlagen — bitte erneut versuchen.');
        return;
      }
      window.location.assign(`/api/aegis/download/${data.downloadId}`);
      setOpen(false);
    } catch {
      setError('Export fehlgeschlagen — bitte erneut versuchen.');
    } finally {
      setBusy(null);
    }
  };

  const item = (format: 'xlsx' | 'docx' | 'pdf', label: string) => (
    <button
      type="button"
      disabled={busy !== null}
      onClick={() => run(format)}
      className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface/80 transition-colors disabled:opacity-50"
    >
      {busy === format ? `${label} …` : label}
    </button>
  );

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Assessment exportieren (Excel, Word, PDF)"
        className="inline-flex items-center gap-1.5 rounded-full border border-border-brand px-2.5 py-1 text-xs font-semibold text-text-secondary hover:text-brand-primary hover:bg-surface/60 transition-colors"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </svg>
        <span className="hidden sm:inline">Export</span>
      </button>
      {open ? (
        <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-border-brand bg-background shadow-lg overflow-hidden">
          {item('xlsx', 'Excel-Arbeitsmappe')}
          {item('docx', 'Word-Bericht')}
          {item('pdf', 'PDF-Bericht')}
          {error ? (
            <div className="px-3 py-1.5 text-[11px] text-red-500 border-t border-border-brand">{error}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
