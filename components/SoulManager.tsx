'use client';

import { useCallback, useEffect, useState } from 'react';

const SECTION_LABELS: Record<string, string> = {
  communication_style: 'Kommunikationsstil',
  output_formats: 'Ausgabeformate',
  decision_support: 'Entscheidungshilfe',
  learning_style: 'Lernstil',
  prioritization: 'Priorisierung',
  avoid: 'Zu vermeiden',
};
const label = (s: string) => SECTION_LABELS[s] ?? s;

type Entry = {
  id: string; section: string; content: string;
  status: string; lastConfirmedAt: string;
};
type Proposal = { id: string; section: string; content: string; reason: string };
type Conflict = { id: string; content: string; axis?: string };
type Snapshot = {
  entries: Entry[]; proposals: Proposal[]; maturity: number; markdown: string;
};

export function SoulManager() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({});
  const [showMd, setShowMd] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/aegis/soul');
      if (!res.ok) throw new Error('load');
      setSnap(await res.json());
    } catch {
      setError('Profil konnte nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const generate = useCallback(async () => {
    setBusy('generate'); setError(null); setNote(null);
    try {
      const res = await fetch('/api/aegis/soul/observe', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d?.message ?? 'Fehler bei der Analyse.');
      else { setNote(d.created > 0 ? `${d.created} neue(r) Vorschlag/Vorschläge.` : 'Keine neuen Muster gefunden.'); await load(); }
    } catch { setError('Netzwerkfehler.'); } finally { setBusy(null); }
  }, [load]);

  const decide = useCallback(
    async (id: string, action: 'accept' | 'edit' | 'reject', archiveConflictId?: string) => {
      setBusy(id); setError(null);
      try {
        const body: Record<string, unknown> = { action };
        if (action === 'edit') body.content = edits[id] ?? '';
        if (archiveConflictId) body.archiveConflictId = archiveConflictId;
        const res = await fetch(`/api/aegis/soul/proposals/${id}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok) {
          setConflicts((m) => { const n = { ...m }; delete n[id]; return n; });
          await load();
        } else if (res.status === 409 && d.conflict) {
          setConflicts((m) => ({ ...m, [id]: d.conflict }));
        } else setError(d?.message ?? 'Aktion fehlgeschlagen.');
      } catch { setError('Netzwerkfehler.'); } finally { setBusy(null); }
    },
    [edits, load],
  );

  const entryAction = useCallback(
    async (id: string, method: 'PATCH' | 'DELETE', action?: string) => {
      setBusy(id); setError(null);
      try {
        const res = await fetch(`/api/aegis/soul/entries/${id}`, {
          method,
          headers: action ? { 'Content-Type': 'application/json' } : undefined,
          body: action ? JSON.stringify({ action }) : undefined,
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d?.message ?? 'Fehlgeschlagen.'); }
        else await load();
      } catch { setError('Netzwerkfehler.'); } finally { setBusy(null); }
    },
    [load],
  );

  if (loading) return <p className="text-sm text-text-secondary">Lädt…</p>;
  if (!snap) return <p className="text-sm text-red-400">{error ?? 'Fehler.'}</p>;

  const active = snap.entries.filter((e) => e.status === 'ACTIVE');
  const archived = snap.entries.filter((e) => e.status === 'ARCHIVED');

  return (
    <div className="space-y-8">
      {error ? <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div> : null}
      {note ? <div className="text-sm text-emerald-300">{note}</div> : null}

      {/* Dashboard */}
      <section className="rounded-xl border border-border-brand bg-surface/50 p-4 flex flex-col justify-between">
        <div>
          <div className="text-sm font-semibold mb-1">Soul-Verständnis</div>
          <div className="font-mono text-2xl">{snap.maturity}%</div>
          <div className="text-xs text-text-secondary mt-1">
            {active.length} aktiv · {archived.length} archiviert
          </div>
        </div>
        <button
          type="button" onClick={generate} disabled={busy === 'generate'}
          className="mt-3 px-3 py-1.5 rounded-lg border border-brand-primary/50 bg-brand-primary/10 text-sm font-semibold text-brand-primary hover:bg-brand-primary/20 disabled:opacity-50 transition-colors"
        >
          {busy === 'generate' ? 'Analysiert…' : 'Vorschläge generieren'}
        </button>
      </section>

      {/* Proposals */}
      <section>
        <h2 className="text-sm font-semibold mb-2">Vorschläge ({snap.proposals.length})</h2>
        <p className="text-xs text-text-secondary/70 mb-3">Wird erst gespeichert, wenn Sie es annehmen. AEGIS kann nur vorschlagen.</p>
        {snap.proposals.length === 0 ? (
          <p className="text-sm text-text-secondary">Keine offenen Vorschläge.</p>
        ) : (
          <ul className="space-y-3">
            {snap.proposals.map((p) => {
              const conflict = conflicts[p.id];
              return (
                <li key={p.id} className="rounded-xl border border-border-brand bg-surface/50 p-4">
                  <span className="text-[0.65rem] font-mono px-2 py-0.5 rounded border border-border-brand text-text-secondary">{label(p.section)}</span>
                  {editing[p.id] ? (
                    <textarea
                      value={edits[p.id] ?? p.content} onChange={(e) => setEdits((m) => ({ ...m, [p.id]: e.target.value }))}
                      rows={2} maxLength={240}
                      className="w-full my-2 px-3 py-2 rounded-lg border border-border-brand bg-background/60 text-sm text-foreground focus:outline-none focus:border-brand-primary"
                    />
                  ) : <p className="text-sm text-foreground my-1">{p.content}</p>}
                  <p className="text-xs text-text-secondary/70 mb-3">Grund: {p.reason}</p>

                  {conflict ? (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-2 text-xs">
                      <p className="mb-2 text-amber-200">
                        Widerspruch{conflict.axis ? ` (Achse: ${conflict.axis})` : ''} zu: &bdquo;{conflict.content}&ldquo;. Welche soll gelten?
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={busy === p.id}
                          onClick={() => decide(p.id, editing[p.id] ? 'edit' : 'accept', conflict.id)}
                          className="px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50">
                          Neue gilt (alte archivieren)
                        </button>
                        <button type="button" disabled={busy === p.id} onClick={() => decide(p.id, 'reject')}
                          className="px-2.5 py-1 rounded border border-border-brand text-text-secondary hover:text-foreground disabled:opacity-50">
                          Alte behalten (Vorschlag verwerfen)
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {editing[p.id] ? (
                      <>
                        <button type="button" disabled={busy === p.id} onClick={() => decide(p.id, 'edit')}
                          className="text-xs px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50">Bearbeitet speichern</button>
                        <button type="button" onClick={() => setEditing((m) => ({ ...m, [p.id]: false }))}
                          className="text-xs px-2.5 py-1 rounded border border-border-brand text-text-secondary hover:text-foreground">Abbrechen</button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busy === p.id} onClick={() => decide(p.id, 'accept')}
                          className="text-xs px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50">Annehmen</button>
                        <button type="button" disabled={busy === p.id}
                          onClick={() => { setEdits((m) => ({ ...m, [p.id]: p.content })); setEditing((m) => ({ ...m, [p.id]: true })); }}
                          className="text-xs px-2.5 py-1 rounded border border-border-brand text-text-secondary hover:text-foreground disabled:opacity-50">Bearbeiten</button>
                        <button type="button" disabled={busy === p.id} onClick={() => decide(p.id, 'reject')}
                          className="text-xs px-2.5 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50">Ablehnen</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Active entries */}
      <EntrySection
        title="Aktive Präferenzen" entries={active} busy={busy}
        emptyText="Noch keine gespeicherten Präferenzen."
        actions={(e) => (
          <>
            <button type="button" disabled={busy === e.id} onClick={() => entryAction(e.id, 'PATCH', 'archive')}
              className="text-xs text-text-secondary hover:text-foreground disabled:opacity-50">Archivieren</button>
            <button type="button" disabled={busy === e.id} onClick={() => entryAction(e.id, 'DELETE')}
              className="text-xs text-text-secondary hover:text-red-400 disabled:opacity-50">Entfernen</button>
          </>
        )}
      />

      {/* Archived */}
      {archived.length > 0 ? (
        <EntrySection
          title="Archiviert" entries={archived} busy={busy} muted
          actions={(e) => (
            <>
              <button type="button" disabled={busy === e.id} onClick={() => entryAction(e.id, 'PATCH', 'restore')}
                className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50">Wiederherstellen</button>
              <button type="button" disabled={busy === e.id} onClick={() => entryAction(e.id, 'DELETE')}
                className="text-xs text-text-secondary hover:text-red-400 disabled:opacity-50">Entfernen</button>
            </>
          )}
        />
      ) : null}

      {/* soul.md export */}
      <section>
        <button type="button" onClick={() => setShowMd((v) => !v)} className="text-xs text-text-secondary hover:text-brand-primary transition-colors">
          {showMd ? '▾' : '▸'} soul.md anzeigen
        </button>
        {showMd ? (
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border-brand bg-background/60 p-3 text-xs text-text-secondary whitespace-pre-wrap">{snap.markdown}</pre>
        ) : null}
      </section>
    </div>
  );
}

function EntrySection({
  title, entries, busy, actions, emptyText, muted,
}: {
  title: string; entries: Entry[]; busy: string | null;
  actions: (e: Entry) => React.ReactNode; emptyText?: string; muted?: boolean;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold mb-2">{title} ({entries.length})</h2>
      {entries.length === 0 ? (
        emptyText ? <p className="text-sm text-text-secondary">{emptyText}</p> : null
      ) : (
        <ul className={`divide-y divide-border-brand/40 rounded-lg border border-border-brand overflow-hidden ${muted ? 'opacity-70' : ''}`}>
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <span className="text-[0.6rem] font-mono text-text-secondary/70 uppercase tracking-wide">
                  {label(e.section)}
                </span>
                <div className="text-sm text-foreground">{e.content}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">{actions(e)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
