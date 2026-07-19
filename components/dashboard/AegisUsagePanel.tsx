'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { formatLatency, formatUsd } from '@/components/dashboard/format';
import { exitReasonSplit } from '@/lib/aegis/usage-stats';

// ───────────────────────── Types (mirror API) ─────────────────────────

type Summary = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostCents: number;
  comparableCostCents: number;
  legacyCostCents: number;
  legacyRequests: number;
  avgLatencyMs: number;
  verifyPassRate: number;
};

type ByDay = {
  date: string;
  requests: number;
  costCents: number;
  comparableCostCents: number;
  avgLatencyMs: number;
};

type ByModel = {
  model: string;
  requests: number;
  costCents: number;
  avgTokensIn: number;
  avgTokensOut: number;
};

type ByMode = {
  mode: string;
  requests: number;
  costCents: number;
  avgLatencyMs: number;
  verifyPassRate: number;
};

type RecentCall = {
  id: string;
  createdAt: string;
  mode: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  verifyPassed: boolean;
  citationCount: number;
};

type ByExitReason = {
  exitReason: string;
  requests: number;
  costCents: number;
};

type ByGuardrail = {
  token: string;
  count: number;
};

type ByServedModel = {
  servedModel: string;
  requests: number;
  costCents: number;
};

type UsageResponse = {
  summary: Summary;
  byDay: ByDay[];
  byModel: ByModel[];
  byMode: ByMode[];
  byExitReason: ByExitReason[];
  byGuardrail: ByGuardrail[];
  byServedModel: ByServedModel[];
  recentCalls: RecentCall[];
};

// ───────────────────────── Color tokens ─────────────────────────

const MODEL_COLORS: Record<string, string> = {
  haiku: '#00BFFF',
  sonnet: '#7b8cde',
  opus: '#e8e44a',
};

const MODE_COLORS: Record<string, string> = {
  CONVERSATIONAL: '#00BFFF',
  ASSESS: '#7b8cde',
  GAP_ANALYZE: '#e8e44a',
  CONTROL_ADVISE: '#f44336',
};

// ───────────────────────── Helpers ─────────────────────────

function modelFamily(model: string): 'haiku' | 'sonnet' | 'opus' | 'other' {
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  return 'other';
}

function modelLabel(model: string): string {
  const fam = modelFamily(model);
  if (fam === 'haiku') return 'Haiku 4.5';
  if (fam === 'sonnet') return 'Sonnet 4.6';
  if (fam === 'opus') return 'Opus 4.7';
  return model;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  // dd.MM HH:mm — short for the recent-calls table
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Aggregate raw byModel rows into Haiku / Sonnet / Opus buckets — the API
// returns one row per concrete model id (e.g. claude-haiku-4-5-20251001).
function bucketByFamily(rows: ByModel[]): Array<{
  family: 'haiku' | 'sonnet' | 'opus';
  label: string;
  color: string;
  requests: number;
  costCents: number;
}> {
  const buckets = new Map<
    'haiku' | 'sonnet' | 'opus',
    { requests: number; costCents: number }
  >();
  for (const row of rows) {
    const fam = modelFamily(row.model);
    if (fam === 'other') continue;
    const cur = buckets.get(fam) ?? { requests: 0, costCents: 0 };
    buckets.set(fam, {
      requests: cur.requests + row.requests,
      costCents: cur.costCents + row.costCents,
    });
  }
  return (['haiku', 'sonnet', 'opus'] as const)
    .filter((f) => buckets.has(f))
    .map((f) => ({
      family: f,
      label: modelLabel(f),
      color: MODEL_COLORS[f],
      requests: buckets.get(f)!.requests,
      costCents: buckets.get(f)!.costCents,
    }));
}

// ───────────────────────── Panel ─────────────────────────

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: UsageResponse };

export function AegisUsagePanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/aegis/usage?days=7', { headers: { Accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(
            (body && typeof body === 'object' && 'error' in body
              ? String((body as { error: unknown }).error)
              : undefined) ?? `HTTP ${r.status}`,
          );
        }
        return (await r.json()) as UsageResponse;
      })
      .then((data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Unbekannter Fehler',
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <LoadingSkeleton />;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-300">
        <div className="font-semibold mb-1">Fehler beim Laden der Usage-Daten</div>
        <div className="text-red-300/80">{state.message}</div>
      </div>
    );
  }

  const { summary, byDay, byModel, byMode, byExitReason, byGuardrail, byServedModel, recentCalls } =
    state.data;

  if (summary.totalRequests === 0) {
    return <EmptyState />;
  }

  return (
    <Loaded
      summary={summary}
      byDay={byDay}
      byModel={byModel}
      byMode={byMode}
      byExitReason={byExitReason}
      byGuardrail={byGuardrail}
      byServedModel={byServedModel}
      recentCalls={recentCalls}
    />
  );
}

// ───────────────────────── Subviews ─────────────────────────

function Loaded({
  summary,
  byDay,
  byModel,
  byMode,
  byExitReason,
  byGuardrail,
  byServedModel,
  recentCalls,
}: UsageResponse) {
  const verifyPct = Math.round(summary.verifyPassRate * 100);
  const verifyOk = verifyPct >= 95;

  const split = useMemo(() => exitReasonSplit(byExitReason), [byExitReason]);

  const modelBuckets = useMemo(() => bucketByFamily(byModel), [byModel]);
  const modelTotal = modelBuckets.reduce((s, x) => s + x.requests, 0);

  const modesSorted = useMemo(
    () => [...byMode].sort((a, b) => b.requests - a.requests),
    [byMode],
  );
  const modesMax = Math.max(...modesSorted.map((m) => m.requests), 1);

  return (
    <div className="space-y-6">
      {/* Verify-Pass-Rate */}
      <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
          <div className="text-xs font-mono uppercase tracking-wider text-text-secondary/80">
            Verify Pass Rate
          </div>
          <div
            className={`text-2xl font-bold font-heading ${
              verifyOk ? 'text-emerald-400' : 'text-orange-400'
            }`}
          >
            {verifyPct}%
          </div>
          <div className="text-xs text-text-secondary">
            Ziel: ≥95% {verifyOk ? '· ✓ erreicht' : '· ⚠ unter Ziel'}
          </div>
        </div>
        <div className="h-2 rounded bg-surface/80 overflow-hidden">
          <div
            className="h-full rounded transition-[width]"
            style={{
              width: `${Math.min(verifyPct, 100)}%`,
              background: verifyOk ? '#4caf50' : '#ffc107',
            }}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Stat
            label="Anfragen"
            value={summary.totalRequests.toLocaleString('de-CH')}
          />
          <Stat label="∅ Latenz" value={formatLatency(summary.avgLatencyMs)} />
          <Stat
            label="Input Tokens"
            value={summary.totalInputTokens.toLocaleString('de-CH')}
            sub={`${summary.totalCachedTokens.toLocaleString('de-CH')} cached`}
          />
          <Stat
            label="Output Tokens"
            value={summary.totalOutputTokens.toLocaleString('de-CH')}
          />
        </div>
      </div>

      {/* Daily bars */}
      <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold font-heading">Tagesübersicht</h3>
            <p className="text-xs text-text-secondary">
              Anfragen pro Tag · Kosten als Label
            </p>
          </div>
          <div className="text-xs font-mono text-text-secondary">
            Σ {formatUsd(summary.totalCostCents)}
          </div>
        </div>
        <DailyBars rows={byDay} />
      </div>

      {/* Console reconciliation */}
      <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
        <h3 className="text-base font-semibold font-heading mb-1">Console-Abgleich</h3>
        <p className="text-xs text-text-secondary mb-4">
          Console-vergleichbar = Zeilen mit aktueller Preisversion. Legacy-Zeilen sind nicht
          vergleichbar und ausgeschlossen — beide Werte sind sichtbar.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <Stat
            label={
              summary.legacyRequests > 0
                ? `Console-vergleichbar (ohne ${summary.legacyRequests} legacy)`
                : 'Console-vergleichbar'
            }
            value={formatUsd(summary.comparableCostCents)}
          />
          <Stat label="Gesamt (alle Zeilen)" value={formatUsd(summary.totalCostCents)} />
          <Stat
            label="Legacy (ausgeschlossen)"
            value={formatUsd(summary.legacyCostCents)}
            sub={`${summary.legacyRequests} Zeilen`}
          />
        </div>
      </div>

      {/* Observability: spend by outcome · guardrails · served models */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
          <h3 className="text-base font-semibold font-heading mb-1">Ausgang (Spend)</h3>
          <p className="text-xs text-text-secondary mb-3">
            Sauber abgeschlossen vs. nicht-done · fix-era
          </p>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-bold font-heading text-emerald-400">
              {Math.round(split.donePct)}%
            </span>
            <span className="text-xs text-text-secondary">der Kosten sauber abgeschlossen</span>
          </div>
          <div className="h-2 rounded bg-surface/80 overflow-hidden mb-3">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${Math.min(split.donePct, 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="done" value={formatUsd(split.doneCostCents)} sub={`${split.doneRequests} Calls`} />
            <Stat
              label="nicht-done"
              value={formatUsd(split.nonDoneCostCents)}
              sub={`${split.nonDoneRequests} Calls`}
            />
          </div>
          {byExitReason.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs font-mono">
              {byExitReason.map((r) => (
                <li key={r.exitReason} className="flex justify-between gap-2">
                  <span className={r.exitReason === 'done' ? 'text-emerald-400' : 'text-orange-400'}>
                    {r.exitReason}
                  </span>
                  <span className="text-text-secondary whitespace-nowrap">
                    {r.requests} · {formatUsd(r.costCents)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
          <h3 className="text-base font-semibold font-heading mb-1">Guardrails</h3>
          <p className="text-xs text-text-secondary mb-3">
            Auslösungen (occurrences), nicht Conversations
          </p>
          {byGuardrail.length === 0 ? (
            <p className="text-xs text-text-secondary">Keine Auslösungen im Zeitraum.</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono">
              {byGuardrail.map((g) => (
                <li key={g.token} className="flex justify-between gap-2">
                  <span>{g.token}</span>
                  <span className="text-text-secondary">{g.count.toLocaleString('de-CH')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
          <h3 className="text-base font-semibold font-heading mb-1">Served Models</h3>
          <p className="text-xs text-text-secondary mb-3">
            Tatsächlich bediente Modelle (informativ)
          </p>
          {byServedModel.length === 0 ? (
            <p className="text-xs text-text-secondary">Keine Daten.</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono">
              {byServedModel.map((s) => (
                <li key={s.servedModel} className="flex justify-between gap-2">
                  <span className="truncate">{s.servedModel}</span>
                  <span className="text-text-secondary whitespace-nowrap">
                    {s.requests} · {formatUsd(s.costCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Models donut + Modes bars */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
          <h3 className="text-base font-semibold font-heading mb-1">
            Model-Verteilung
          </h3>
          <p className="text-xs text-text-secondary mb-4">
            Routing-Verteilung (Haiku/Sonnet/Opus)
          </p>
          {modelBuckets.length === 0 ? (
            <p className="text-sm text-text-secondary">Keine Model-Daten.</p>
          ) : (
            <div className="flex items-center gap-6">
              <Donut
                total={modelTotal}
                segments={modelBuckets.map((m) => ({
                  label: m.label,
                  count: m.requests,
                  color: m.color,
                }))}
                size={170}
              />
              <ul className="flex-1 space-y-2 text-sm">
                {modelBuckets.map((m) => (
                  <li key={m.family} className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-sm shrink-0"
                      style={{ background: m.color }}
                    />
                    <span className="font-semibold w-20">{m.label}</span>
                    <span className="text-text-secondary flex-1">
                      {modelTotal > 0
                        ? Math.round((m.requests / modelTotal) * 100)
                        : 0}
                      %
                    </span>
                    <span className="font-mono">{m.requests}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
          <h3 className="text-base font-semibold font-heading mb-1">
            Mode-Verteilung
          </h3>
          <p className="text-xs text-text-secondary mb-4">
            ASSESS · GAP_ANALYZE · CONVERSATIONAL
          </p>
          {modesSorted.length === 0 ? (
            <p className="text-sm text-text-secondary">Keine Mode-Daten.</p>
          ) : (
            <ul className="space-y-3">
              {modesSorted.map((m) => (
                <li key={m.mode} className="flex items-center gap-3">
                  <span className="w-36 text-sm font-mono truncate">{m.mode}</span>
                  <div className="flex-1 h-5 rounded bg-surface/80 overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${(m.requests / modesMax) * 100}%`,
                        background: MODE_COLORS[m.mode] ?? '#00BFFF',
                      }}
                    />
                  </div>
                  <span className="w-10 text-sm font-mono text-right">
                    {m.requests}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recent calls */}
      <div className="rounded-xl border border-border-brand bg-surface/50 overflow-hidden">
        <div className="px-5 py-4 border-b border-border-brand">
          <h3 className="text-base font-semibold font-heading">
            Letzte {recentCalls.length} Calls
          </h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Sortiert nach Zeitpunkt (neueste zuerst)
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-background/40 border-b border-border-brand text-text-secondary text-[0.7rem] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Zeit</th>
                <th className="px-3 py-2 text-left font-semibold">Mode</th>
                <th className="px-3 py-2 text-left font-semibold">Model</th>
                <th className="px-3 py-2 text-right font-semibold">Tok In</th>
                <th className="px-3 py-2 text-right font-semibold">Tok Out</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Latenz</th>
                <th className="px-3 py-2 text-right font-semibold">Quellen</th>
                <th className="px-3 py-2 text-center font-semibold">Verify</th>
              </tr>
            </thead>
            <tbody>
              {recentCalls.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-border-brand/40 last:border-b-0 hover:bg-background/30"
                >
                  <td className="px-3 py-2 font-mono text-text-secondary whitespace-nowrap">
                    {formatTime(c.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-block px-1.5 py-0.5 text-[0.65rem] font-mono uppercase rounded"
                      style={{
                        background: `${MODE_COLORS[c.mode] ?? '#00BFFF'}22`,
                        color: MODE_COLORS[c.mode] ?? '#00BFFF',
                      }}
                    >
                      {c.mode}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-text-secondary">
                    {modelLabel(c.model)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.inputTokens.toLocaleString('de-CH')}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.outputTokens.toLocaleString('de-CH')}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatUsd(c.costCents)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatLatency(c.latencyMs)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{c.citationCount}</td>
                  <td className="px-3 py-2 text-center">
                    {c.verifyPassed ? (
                      <span className="text-emerald-400" title="Verified">
                        ✓
                      </span>
                    ) : (
                      <span className="text-red-400" title="Failed">
                        ✗
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-brand bg-surface/30 p-10 text-center">
      <div className="text-4xl mb-3" aria-hidden="true">
        🛰️
      </div>
      <h3 className="text-lg font-semibold font-heading mb-1">
        Noch keine AEGIS-Anfragen
      </h3>
      <p className="text-sm text-text-secondary mb-6 max-w-md mx-auto">
        Sobald die erste Frage gestellt wurde, erscheinen hier Tagesverlauf,
        Model-Verteilung, Kosten und Verify-Statistiken.
      </p>
      <Link
        href="/aegis"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 transition-colors"
      >
        → Zu AEGIS
      </Link>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-32 rounded-xl border border-border-brand bg-surface/50" />
      <div className="h-48 rounded-xl border border-border-brand bg-surface/50" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-64 rounded-xl border border-border-brand bg-surface/50" />
        <div className="h-64 rounded-xl border border-border-brand bg-surface/50" />
      </div>
      <div className="h-80 rounded-xl border border-border-brand bg-surface/50" />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <div className="text-[0.65rem] font-mono uppercase tracking-wider text-text-secondary/80">
        {label}
      </div>
      <div className="mt-0.5 font-mono font-semibold">{value}</div>
      {sub ? (
        <div className="text-[0.65rem] text-text-secondary">{sub}</div>
      ) : null}
    </div>
  );
}

// Inline SVG donut — same maths as the server-side one in app/dashboard/page.tsx
// but local so this client bundle is self-contained.
function Donut({
  total,
  segments,
  size = 160,
}: {
  total: number;
  segments: Array<{ label: string; count: number; color: string }>;
  size?: number;
}) {
  if (total === 0) {
    return (
      <div
        className="rounded-full border border-dashed border-border-brand text-text-secondary text-xs flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        Keine Daten
      </div>
    );
  }
  let acc = 0;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="shrink-0 text-foreground"
      aria-hidden="true"
    >
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="14"
      />
      {segments.map((seg) => {
        const p = (seg.count / total) * 100;
        const dashOffset = -acc;
        const el = (
          <circle
            key={seg.label}
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke={seg.color}
            strokeWidth="14"
            pathLength={100}
            strokeDasharray={`${p} 100`}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 50 50)"
          />
        );
        acc += p;
        return el;
      })}
      <text
        x="50"
        y="49"
        textAnchor="middle"
        fill="currentColor"
        style={{ fontSize: 12, fontWeight: 700 }}
      >
        {total}
      </text>
      <text
        x="50"
        y="61"
        textAnchor="middle"
        fill="currentColor"
        style={{ fontSize: 6 }}
        opacity={0.55}
      >
        Calls
      </text>
    </svg>
  );
}

// Daily bars (SVG). Buckets the response into 7 ascending day slots so the axis
// stays consistent even on days with no calls.
function DailyBars({ rows }: { rows: ByDay[] }) {
  // Build full 7-day window ending today.
  const days = useMemo(() => {
    const map = new Map(rows.map((r) => [r.date, r]));
    const arr: ByDay[] = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      arr.push(
        map.get(iso) ?? {
          date: iso,
          requests: 0,
          costCents: 0,
          comparableCostCents: 0,
          avgLatencyMs: 0,
        },
      );
    }
    return arr;
  }, [rows]);

  const max = Math.max(...days.map((d) => d.requests), 1);

  return (
    <div className="flex items-end gap-3 h-40">
      {days.map((d) => {
        const heightPct = (d.requests / max) * 100;
        const dayShort = new Date(d.date).toLocaleDateString('de-DE', {
          weekday: 'short',
        });
        return (
          <div
            key={d.date}
            className="flex-1 flex flex-col items-center gap-1.5 min-w-0"
          >
            <div className="text-[0.65rem] font-mono text-text-secondary">
              {d.requests > 0 ? formatUsd(d.costCents) : '—'}
            </div>
            <div className="w-full flex items-end h-24">
              <div
                className="w-full rounded-t bg-brand-primary/80 hover:bg-brand-primary transition-colors"
                style={{ height: `${heightPct}%`, minHeight: d.requests > 0 ? 2 : 0 }}
                title={`${d.date}: ${d.requests} Anfragen · ${formatUsd(d.costCents)} gesamt · ${formatUsd(d.comparableCostCents)} console-vergleichbar`}
              />
            </div>
            <div className="text-xs font-mono text-foreground">{d.requests}</div>
            <div className="text-[0.65rem] text-text-secondary">{dayShort}</div>
          </div>
        );
      })}
    </div>
  );
}
