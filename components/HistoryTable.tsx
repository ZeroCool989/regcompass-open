'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';

type AegisLog = {
  id: string;
  createdAt: string;
  conversationId: string;
  mode: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Null for subscription/unknown-priced runs — shown as "—". */
  costCents: number | null;
  latencyMs: number;
  iterations: number;
  toolCalls: number;
  verifyPassed: boolean;
  citationCount: number;
};

type SortKey = 'createdAt' | 'costCents' | 'latencyMs' | 'mode';
type SortDir = 'asc' | 'desc';

const MODE_LABELS: Record<string, string> = {
  ASSESS: 'Assess',
  GAP_ANALYZE: 'Gap Analyze',
  CONTROL_ADVISE: 'Control Advise',
  CONVERSATIONAL: 'Conversational',
};

const ALL_MODES = ['All', 'ASSESS', 'GAP_ANALYZE', 'CONVERSATIONAL'] as const;
const ALL_MODELS = ['All', 'haiku', 'sonnet', 'opus'] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('de-CH', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTokens(input: number, output: number): string {
  const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  return `${fmtK(input)}/${fmtK(output)}`;
}

function formatCost(cents: number | null): string {
  if (cents == null) return '—';
  if (cents < 1) return `$${(cents / 100).toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function modelShort(model: string): string {
  if (model.includes('haiku')) return 'Haiku';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('opus')) return 'Opus';
  return model;
}

export function HistoryTable({ logs }: { logs: AegisLog[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [modeFilter, setModeFilter] = useState('All');
  const [modelFilter, setModelFilter] = useState('All');

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const filtered = useMemo(() => {
    let result = logs;
    if (modeFilter !== 'All') {
      result = result.filter((l) => l.mode === modeFilter);
    }
    if (modelFilter !== 'All') {
      result = result.filter((l) => l.model.includes(modelFilter));
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...result].sort((a, b) => {
      if (sortKey === 'createdAt') return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (sortKey === 'costCents') return dir * ((a.costCents ?? 0) - (b.costCents ?? 0));
      if (sortKey === 'latencyMs') return dir * (a.latencyMs - b.latencyMs);
      if (sortKey === 'mode') return dir * a.mode.localeCompare(b.mode);
      return 0;
    });
  }, [logs, sortKey, sortDir, modeFilter, modelFilter]);

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    const active = sortKey === field;
    return (
      <button
        onClick={() => toggleSort(field)}
        className="flex items-center gap-1 text-xs uppercase tracking-wider font-semibold text-text-secondary hover:text-foreground transition-colors"
      >
        {label}
        <span className={`text-[10px] ${active ? 'text-brand-primary' : 'opacity-30'}`}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-3xl font-bold font-heading mb-2">AEGIS-Verlauf</h1>
        <p className="text-text-secondary mb-8">Noch keine AEGIS-Konversationen vorhanden.</p>
        <Link
          href="/aegis"
          className="px-6 py-3 bg-brand-primary text-black font-semibold rounded-lg hover:bg-cyan-400 transition"
        >
          AEGIS fragen
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold font-heading mb-1">AEGIS-Verlauf</h1>
        <p className="text-text-secondary text-sm mb-4">
          Alle AEGIS-Konversationen — Modus, Kosten, Qualität.
        </p>
        <p className="text-xs text-text-secondary">
          {logs.length} Einträge
        </p>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={modeFilter}
          onChange={(e) => setModeFilter(e.target.value)}
          className="px-3 py-2 bg-surface border border-border-brand rounded-lg text-sm text-foreground focus:outline-none focus:border-brand-primary"
        >
          {ALL_MODES.map((m) => (
            <option key={m} value={m}>
              {m === 'All' ? 'Alle Modi' : MODE_LABELS[m] ?? m}
            </option>
          ))}
        </select>
        <select
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="px-3 py-2 bg-surface border border-border-brand rounded-lg text-sm text-foreground focus:outline-none focus:border-brand-primary"
        >
          {ALL_MODELS.map((m) => (
            <option key={m} value={m}>
              {m === 'All' ? 'Alle Modelle' : m.charAt(0).toUpperCase() + m.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {(modeFilter !== 'All' || modelFilter !== 'All') && (
        <p className="text-xs text-text-secondary mb-4">
          {filtered.length} Ergebnis{filtered.length !== 1 ? 'se' : ''}
        </p>
      )}

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-brand">
              <th className="text-left py-3 px-3"><SortHeader label="Datum" field="createdAt" /></th>
              <th className="text-left py-3 px-3"><SortHeader label="Modus" field="mode" /></th>
              <th className="text-left py-3 px-3">
                <span className="text-xs uppercase tracking-wider font-semibold text-text-secondary">Model</span>
              </th>
              <th className="text-left py-3 px-3">
                <span className="text-xs uppercase tracking-wider font-semibold text-text-secondary">Tokens</span>
              </th>
              <th className="text-left py-3 px-3"><SortHeader label="Kosten" field="costCents" /></th>
              <th className="text-left py-3 px-3"><SortHeader label="Latenz" field="latencyMs" /></th>
              <th className="text-center py-3 px-3">
                <span className="text-xs uppercase tracking-wider font-semibold text-text-secondary">Verify</span>
              </th>
              <th className="text-left py-3 px-3">
                <span className="text-xs uppercase tracking-wider font-semibold text-text-secondary">Conversation-ID</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l, i) => (
              <tr
                key={l.id}
                className={`border-b border-border-brand/50 hover:bg-brand-primary/5 transition-colors ${
                  i % 2 === 1 ? 'bg-surface/30' : ''
                }`}
              >
                <td className="py-3 px-3 text-xs text-text-secondary whitespace-nowrap font-mono">
                  {formatDate(l.createdAt)}
                </td>
                <td className="py-3 px-3">
                  <span className="px-2 py-0.5 text-xs font-semibold rounded bg-brand-primary/15 text-brand-primary">
                    {MODE_LABELS[l.mode] ?? l.mode}
                  </span>
                </td>
                <td className="py-3 px-3 text-xs font-mono">{modelShort(l.model)}</td>
                <td className="py-3 px-3 text-xs font-mono">{formatTokens(l.inputTokens, l.outputTokens)}</td>
                <td className="py-3 px-3 text-xs font-mono">{formatCost(l.costCents)}</td>
                <td className="py-3 px-3 text-xs font-mono">{formatLatency(l.latencyMs)}</td>
                <td className="py-3 px-3 text-center">
                  {l.verifyPassed ? (
                    <span className="text-emerald-400" title="Verifiziert">&#10003;</span>
                  ) : (
                    <span className="text-red-400" title="Verify fehlgeschlagen">&#10007;</span>
                  )}
                </td>
                <td className="py-3 px-3 text-xs font-mono text-text-secondary truncate max-w-[180px]" title={l.conversationId}>
                  {l.conversationId.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="md:hidden space-y-3">
        {filtered.map((l) => (
          <div
            key={l.id}
            className="p-4 bg-surface border border-border-brand rounded-lg"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-brand-primary/15 text-brand-primary">
                {MODE_LABELS[l.mode] ?? l.mode}
              </span>
              <span className="text-xs font-mono text-text-secondary">{modelShort(l.model)}</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-secondary">
              <span>{formatDate(l.createdAt)}</span>
              <span>{formatCost(l.costCents)}</span>
              <span>{formatLatency(l.latencyMs)}</span>
              <span>{l.verifyPassed ? '✓' : '✗'}</span>
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && logs.length > 0 && (
        <p className="text-center text-text-secondary py-12">Keine Einträge entsprechen Ihren Filterkriterien.</p>
      )}
    </div>
  );
}
