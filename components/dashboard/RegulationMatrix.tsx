'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export type RegRow = {
  id: string;
  shortName: string;
  name: string;
  jurisdiction: string;
  bindingLevel: string;
  reqCount: number;
  controlCount: number;
  gapCount: number;
  coveragePct: number;
};

type SortKey =
  | 'name'
  | 'jurisdiction'
  | 'bindingLevel'
  | 'reqCount'
  | 'controlCount'
  | 'gapCount'
  | 'coveragePct';

type SortDir = 'asc' | 'desc';

const COLUMNS: Array<{
  key: SortKey;
  label: string;
  align?: 'left' | 'right';
  className?: string;
}> = [
  { key: 'name', label: 'Regulation', align: 'left' },
  { key: 'jurisdiction', label: 'Jur.', align: 'left' },
  { key: 'bindingLevel', label: 'Binding', align: 'left' },
  { key: 'reqCount', label: 'Anf.', align: 'right' },
  { key: 'controlCount', label: 'Mit Ctrl', align: 'right' },
  { key: 'gapCount', label: 'Lücke', align: 'right' },
  { key: 'coveragePct', label: 'Coverage', align: 'right' },
];

const BINDING_LABEL: Record<string, string> = {
  mandatory: 'mandatory',
  supervisory_expectation: 'supervisory',
  best_practice: 'best practice',
};

function coverageColor(pct: number): string {
  if (pct >= 100) return '#4caf50';
  if (pct >= 50) return '#ffc107';
  return '#f44336';
}

export function RegulationMatrix({ rows }: { rows: RegRow[] }) {
  // Default: highest coverage first — surfaces "wins" at the top.
  const [sortKey, setSortKey] = useState<SortKey>('coveragePct');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Numeric columns default to desc (highest first); text columns asc.
      const isNumeric = ['reqCount', 'controlCount', 'gapCount', 'coveragePct'].includes(key);
      setSortDir(isNumeric ? 'desc' : 'asc');
    }
  }

  return (
    <div className="rounded-xl border border-border-brand bg-surface/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-background/40 border-b border-border-brand">
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key === sortKey;
                const arrow = active ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
                return (
                  <th
                    key={col.key}
                    scope="col"
                    className={`px-3 py-2.5 font-semibold whitespace-nowrap text-[0.72rem] uppercase tracking-wider ${
                      col.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={`inline-flex items-center gap-1 transition-colors ${
                        active
                          ? 'text-brand-primary'
                          : 'text-text-secondary hover:text-foreground'
                      }`}
                    >
                      <span>{col.label}</span>
                      <span className="opacity-60 font-mono text-[0.7rem]">{arrow}</span>
                    </button>
                  </th>
                );
              })}
              <th
                scope="col"
                className="px-3 py-2.5 font-semibold text-left text-[0.72rem] uppercase tracking-wider text-text-secondary"
              >
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => {
              const color = coverageColor(r.coveragePct);
              return (
                <tr
                  key={r.id}
                  className="border-b border-border-brand/40 last:border-b-0 hover:bg-background/30 transition-colors"
                >
                  <td className="px-3 py-2.5">
                    <Link
                      href={`/kb?regulation=${r.id}`}
                      className="text-foreground hover:text-brand-primary transition-colors font-medium"
                    >
                      <span className="font-mono text-text-secondary mr-2">
                        {r.shortName}
                      </span>
                      <span className="hidden md:inline text-text-secondary/80">
                        {r.name}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-block px-1.5 py-0.5 text-[0.65rem] font-mono uppercase rounded bg-background/60 border border-border-brand">
                      {r.jurisdiction}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-text-secondary">
                    {BINDING_LABEL[r.bindingLevel] ?? r.bindingLevel}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">{r.reqCount}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-emerald-400">
                    {r.controlCount}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-orange-400">
                    {r.gapCount}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="inline-flex items-center gap-2">
                      <span className="font-mono font-semibold" style={{ color }}>
                        {r.coveragePct}%
                      </span>
                      <div className="w-16 h-1.5 rounded bg-surface/80 overflow-hidden">
                        <div
                          className="h-full"
                          style={{
                            width: `${r.coveragePct}%`,
                            background: color,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {r.coveragePct >= 100 ? (
                      <span className="text-emerald-400 font-semibold">✓ Vollständig</span>
                    ) : r.coveragePct >= 50 ? (
                      <span className="text-yellow-400">◐ Teilweise</span>
                    ) : (
                      <span className="text-red-400">✗ Lücken</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
