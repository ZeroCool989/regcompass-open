'use client';

import { useEffect, useState } from 'react';
import { formatLatency, formatUsd } from '@/components/dashboard/format';

type UsageSummary = {
  totalRequests: number;
  totalCostCents: number;
  avgLatencyMs: number;
  verifyPassRate: number;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: UsageSummary };

type Accent = 'primary' | 'success' | 'warning' | 'neutral';

function accentClass(accent: Accent | undefined): string {
  switch (accent) {
    case 'primary':
      return 'text-brand-primary';
    case 'success':
      return 'text-emerald-400';
    case 'warning':
      return 'text-orange-400';
    default:
      return 'text-foreground';
  }
}

function KpiSlot({
  label,
  value,
  hint,
  accent,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: Accent;
  loading?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border-brand bg-surface/50 p-4">
      <div
        className={`text-3xl font-bold font-heading ${
          loading ? 'animate-pulse text-text-secondary/40' : accentClass(accent)
        }`}
      >
        {loading ? '—' : value}
      </div>
      <div className="mt-0.5 text-sm font-semibold">{label}</div>
      {hint ? (
        <div className="mt-0.5 text-[0.7rem] text-text-secondary">{hint}</div>
      ) : null}
    </div>
  );
}

/**
 * 4 KPI tiles for the AEGIS cost tab: Anfragen · Kosten · ∅ Latenz · Verify.
 * Fetches /api/aegis/usage?days=7 once on mount.
 */
export function AegisUsageKpis() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/aegis/usage?days=7', { headers: { Accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = (await r.json()) as { summary?: UsageSummary };
        if (!json.summary) throw new Error('missing summary');
        if (!cancelled) setState({ kind: 'ready', data: json.summary });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <>
        <KpiSlot label="Anfragen" value="" hint="Letzte 7 Tage" loading />
        <KpiSlot label="Kosten" value="" hint="Letzte 7 Tage" loading />
        <KpiSlot label="∅ Latenz" value="" hint="Mittlerer Wert" loading />
        <KpiSlot label="Verify-Pass-Rate" value="" hint="Ziel ≥95%" loading />
      </>
    );
  }

  if (state.kind === 'error') {
    return (
      <>
        <KpiSlot label="Anfragen" value="—" hint="Daten nicht verfügbar" />
        <KpiSlot label="Kosten" value="—" hint="Daten nicht verfügbar" />
        <KpiSlot label="∅ Latenz" value="—" hint="Daten nicht verfügbar" />
        <KpiSlot label="Verify-Pass-Rate" value="—" hint="Daten nicht verfügbar" />
      </>
    );
  }

  const { totalRequests, totalCostCents, avgLatencyMs, verifyPassRate } =
    state.data;
  const verifyPct = Math.round(verifyPassRate * 100);
  const verifyAccent: Accent =
    totalRequests === 0 ? 'neutral' : verifyPct >= 95 ? 'success' : 'warning';

  return (
    <>
      <KpiSlot
        label="Anfragen"
        value={totalRequests.toLocaleString('de-CH')}
        hint="Letzte 7 Tage"
        accent="primary"
      />
      <KpiSlot
        label="Kosten"
        value={formatUsd(totalCostCents)}
        hint="Letzte 7 Tage"
        accent="primary"
      />
      <KpiSlot
        label="∅ Latenz"
        value={totalRequests === 0 ? '—' : formatLatency(avgLatencyMs)}
        hint="Mittlerer Wert"
      />
      <KpiSlot
        label="Verify-Pass-Rate"
        value={totalRequests === 0 ? '—' : `${verifyPct}%`}
        hint="Ziel ≥95%"
        accent={verifyAccent}
      />
    </>
  );
}
