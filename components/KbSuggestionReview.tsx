'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { TranslatePanel } from '@/components/TranslatePanel';

export type IngestStatus = 'INGESTING' | 'INGESTED' | 'FAILED' | 'NEEDS_INPUT';

export type IngestDocDto = {
  id: string;
  status: IngestStatus;
  error: string | null;
  documentUrl: string | null;
  sourceUrl: string | null;
  originalLanguage?: string | null;
};

export type SuggestionDto = {
  id: string;
  sourceName: string;
  sourceUrl: string;
  regulation: string;
  proposedRequirementId: string | null;
  proposedRequirementText: string;
  relevanceForFinancialSector: string;
  bindingLevel: string;
  rationale: string;
  status: string;
  reviewedBy: string | null;
  document?: IngestDocDto | null;
};

const STATUS_FILTERS = [
  { key: 'ALL', label: 'Alle' },
  { key: 'PROPOSED', label: 'Offen' },
  { key: 'ACCEPTED', label: 'Angenommen' },
  { key: 'REJECTED', label: 'Abgelehnt' },
];

const statusStyle: Record<string, string> = {
  PROPOSED: 'bg-amber-500/20 text-amber-200',
  ACCEPTED: 'bg-emerald-600/25 text-emerald-200',
  REJECTED: 'bg-red-500/20 text-red-300',
};
const statusLabel: Record<string, string> = {
  PROPOSED: 'Offen',
  ACCEPTED: 'Angenommen',
  REJECTED: 'Abgelehnt',
};

const ingestStyle: Record<IngestStatus, string> = {
  INGESTING: 'bg-sky-500/20 text-sky-200',
  INGESTED: 'bg-emerald-600/25 text-emerald-200',
  FAILED: 'bg-red-500/20 text-red-300',
  NEEDS_INPUT: 'bg-amber-500/20 text-amber-200',
};
const ingestLabel: Record<IngestStatus, string> = {
  INGESTING: 'Wird eingespeist …',
  INGESTED: 'In Bibliothek',
  FAILED: 'Einspeisung fehlgeschlagen',
  NEEDS_INPUT: 'Dokument benötigt',
};

export function KbSuggestionReview({ initial }: { initial: SuggestionDto[] }) {
  const [items, setItems] = useState<SuggestionDto[]>(initial);
  const [filter, setFilter] = useState('ALL');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(
    () => (filter === 'ALL' ? items : items.filter((i) => i.status === filter)),
    [items, filter],
  );

  function patchItem(id: string, patch: Partial<SuggestionDto>) {
    setItems((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function review(id: string, action: 'accept' | 'reject') {
    setBusyId(id);
    try {
      const res = await fetch(`/api/regulatory-suggestions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const { item, documentId } = (await res.json()) as {
          item: { status: string; reviewedBy: string | null };
          documentId: string | null;
        };
        patchItem(id, {
          status: item.status,
          reviewedBy: item.reviewedBy,
          document:
            action === 'accept' && documentId
              ? { id: documentId, status: 'INGESTING', error: null, documentUrl: null, sourceUrl: null }
              : null,
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f.key ? 'bg-brand-primary text-white' : 'bg-white/5 text-text-secondary hover:bg-white/10'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-text-secondary">
          Keine Vorschläge für diesen Filter.
        </p>
      ) : (
        <ul className="space-y-4">
          {filtered.map((s) => (
            <li key={s.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[0.68rem] ${statusStyle[s.status] ?? 'bg-white/10'}`}>
                  {statusLabel[s.status] ?? s.status}
                </span>
                <span className="text-sm font-semibold text-foreground">{s.regulation}</span>
                {s.proposedRequirementId && (
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[0.68rem] text-text-secondary">
                    {s.proposedRequirementId}
                  </span>
                )}
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[0.68rem] text-text-secondary">
                  Relevanz: {s.relevanceForFinancialSector}
                </span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[0.68rem] text-text-secondary">
                  Bindung: {s.bindingLevel}
                </span>
              </div>
              <p className="text-sm text-foreground">{s.proposedRequirementText}</p>
              <p className="mt-2 text-sm">
                <span className="font-medium text-foreground">Begründung: </span>
                <span className="text-text-secondary">{s.rationale}</span>
              </p>
              <a
                href={s.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-brand-primary hover:underline"
              >
                {s.sourceName} ↗
              </a>
              {s.status === 'PROPOSED' ? (
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={busyId === s.id}
                    onClick={() => review(s.id, 'accept')}
                    className="rounded-lg bg-emerald-600/25 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-600/40 disabled:opacity-50"
                  >
                    Annehmen
                  </button>
                  <button
                    disabled={busyId === s.id}
                    onClick={() => review(s.id, 'reject')}
                    className="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-500/30 disabled:opacity-50"
                  >
                    Ablehnen
                  </button>
                </div>
              ) : (
                <>
                  {s.reviewedBy && <p className="mt-3 text-xs text-text-secondary">Geprüft von {s.reviewedBy}</p>}
                  {s.status === 'ACCEPTED' && s.document && (
                    <IngestionPanel
                      doc={s.document}
                      onChange={(d) => patchItem(s.id, { document: d })}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ingestion status + manual fallback for an accepted suggestion's document. */
function IngestionPanel({ doc, onChange }: { doc: IngestDocDto; onChange: (d: IngestDocDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [showTranslate, setShowTranslate] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isForeign = !!doc.originalLanguage && !['DE', 'EN'].includes(doc.originalLanguage.toUpperCase());

  // Poll while ingestion is in progress.
  useEffect(() => {
    if (doc.status !== 'INGESTING') return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/regulatory-documents?id=${doc.id}`);
        if (!res.ok) return;
        const { document } = (await res.json()) as { document: IngestDocDto | null };
        if (active && document && document.status !== 'INGESTING') onChange(document);
      } catch {
        /* keep polling */
      }
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [doc.status, doc.id, onChange]);

  async function retry(body?: BodyInit, headers?: HeadersInit) {
    setBusy(true);
    try {
      const res = await fetch(`/api/regulatory-documents/${doc.id}/ingest`, { method: 'POST', body, headers });
      if (res.ok) {
        const { document } = (await res.json()) as { document: IngestDocDto | null };
        if (document) onChange(document);
      }
    } finally {
      setBusy(false);
    }
  }

  const needsManual = doc.status === 'FAILED' || doc.status === 'NEEDS_INPUT';

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[0.68rem] ${ingestStyle[doc.status]}`}>
          {ingestLabel[doc.status]}
        </span>
        {doc.status === 'INGESTED' && (
          <a href="/library" className="text-xs text-brand-primary hover:underline">
            In Bibliothek öffnen ↗
          </a>
        )}
        {doc.status === 'INGESTED' && (
          <button
            onClick={() => setShowTranslate((v) => !v)}
            className={`text-xs ${isForeign ? 'text-sky-300' : 'text-text-secondary'} hover:underline`}
            title="Dokument übersetzen (DeepL)"
          >
            🌐 Übersetzen{isForeign && doc.originalLanguage ? ` (${doc.originalLanguage})` : ''}
          </button>
        )}
        {doc.error && <span className="text-[0.68rem] text-text-secondary">({doc.error})</span>}
      </div>

      {doc.status === 'INGESTED' && showTranslate && (
        <div className="mt-3">
          <TranslatePanel documentId={doc.id} originalLanguage={doc.originalLanguage ?? null} />
        </div>
      )}

      {needsManual && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-text-secondary">
            Das Dokument konnte nicht automatisch geladen werden. Direkt-Link einfügen oder Datei hochladen:
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://… (PDF/HTML)"
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-foreground placeholder:text-text-secondary/60"
            />
            <button
              disabled={busy || !link.trim()}
              onClick={() => retry(JSON.stringify({ documentUrl: link.trim() }), { 'Content-Type': 'application/json' })}
              className="rounded-md bg-brand-primary/20 px-2.5 py-1 text-xs font-medium text-brand-primary hover:bg-brand-primary/30 disabled:opacity-50"
            >
              Link laden
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append('file', file);
                void retry(fd);
                e.target.value = '';
              }}
            />
            <button
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-white/20 disabled:opacity-50"
            >
              Datei hochladen
            </button>
            <button
              disabled={busy}
              onClick={() => retry()}
              className="rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-white/20 disabled:opacity-50"
            >
              Erneut versuchen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
