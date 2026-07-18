'use client';

import { useMemo, useState } from 'react';

export type NewsDto = {
  id: string;
  title: string;
  summary: string;
  relevance: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string | null;
  jurisdiction: string;
  tags: string[];
};

const JURISDICTION_FILTERS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'Alle' },
  { key: 'EU', label: 'EU' },
  { key: 'DE', label: 'Deutschland' },
  { key: 'CH', label: 'Schweiz' },
  { key: 'INTL', label: 'International' },
];

// `label` is shown on the button; `match` are the lowercase substrings tested
// against each item's tags. Decoupled so e.g. "EU AI Act" also catches the
// model's shorter "AI Act" tag. Empty `match` ("Alle") means no filtering.
const TAG_FILTERS: { label: string; match: string[] }[] = [
  { label: 'Alle', match: [] },
  { label: 'AI Compliance', match: ['ai compliance'] },
  { label: 'IT Compliance', match: ['it compliance'] },
  { label: 'EU AI Act', match: ['ai act', 'ki-verordnung', 'ki verordnung'] },
  { label: 'DORA', match: ['dora'] },
  { label: 'NIS2', match: ['nis2', 'nis 2'] },
  { label: 'CRA', match: ['cra', 'cyber resilience'] },
  { label: 'Datenschutz', match: ['datenschutz', 'gdpr', 'dsgvo', 'fadp', 'revdsg'] },
];

function jurisdictionLabel(j: string): string {
  return { EU: 'EU', DE: 'Deutschland', CH: 'Schweiz', INTL: 'International' }[j] ?? j;
}

export function RegulatoryNewsFeed({ items }: { items: NewsDto[] }) {
  const [jur, setJur] = useState('ALL');
  const [tag, setTag] = useState('Alle');

  const filtered = useMemo(() => {
    const active = TAG_FILTERS.find((f) => f.label === tag);
    const match = active?.match ?? [];
    return items.filter((i) => {
      if (jur !== 'ALL' && i.jurisdiction !== jur) return false;
      if (match.length > 0) {
        const tags = i.tags.map((x) => x.toLowerCase());
        if (!match.some((m) => tags.some((x) => x.includes(m)))) return false;
      }
      return true;
    });
  }, [items, jur, tag]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {JURISDICTION_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setJur(f.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              jur === f.key ? 'bg-brand-primary text-white' : 'bg-white/5 text-text-secondary hover:bg-white/10'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="mb-6 flex flex-wrap gap-2">
        {TAG_FILTERS.map((t) => (
          <button
            key={t.label}
            onClick={() => setTag(t.label)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              tag === t.label ? 'bg-emerald-600/30 text-emerald-200' : 'bg-white/5 text-text-secondary hover:bg-white/10'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-text-secondary">
          Aktuell keine Einträge für diesen Filter. Der Radar aktualisiert täglich um 10:00 Uhr (Europe/Zurich).
        </p>
      ) : (
        <ul className="space-y-4">
          {filtered.map((n) => (
            <li key={n.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-1 flex items-center gap-2 text-[0.7rem] uppercase tracking-wide text-text-secondary">
                <span className="rounded bg-white/10 px-1.5 py-0.5">{jurisdictionLabel(n.jurisdiction)}</span>
                <span>{n.sourceName}</span>
                {n.publishedAt && <span>· {n.publishedAt.slice(0, 10)}</span>}
              </div>
              <a
                href={n.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base font-semibold text-foreground hover:underline"
              >
                {n.title}
              </a>
              <p className="mt-1 text-sm text-text-secondary">{n.summary}</p>
              <p className="mt-2 text-sm">
                <span className="font-medium text-foreground">Relevanz: </span>
                <span className="text-text-secondary">{n.relevance}</span>
              </p>
              {n.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {n.tags.map((t) => (
                    <span key={t} className="rounded bg-white/10 px-1.5 py-0.5 text-[0.68rem] text-text-secondary">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <a
                href={n.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-xs text-brand-primary hover:underline"
              >
                Quelle öffnen ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
