'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  AUDIENCE_LABELS,
  CATEGORY_LABELS,
  label,
} from '@/lib/kb/labels';

type Control = {
  id: string;
  action: string;
  description: string;
  standard?: string;
  nistFunction?: string;
  priority: string;
};

type Requirement = {
  id: string;
  title: string;
  titleDe?: string;
  regulation: string;
  article: string;
  jurisdiction: string[];
  summary: string;
  summaryDe?: string;
  riskTier?: string;
  audience: string[];
  category: string;
  relevanceForFinancialSector: string;
  bindingLevel: string;
  tags: string[];
  verified: boolean;
  controls: Control[];
};

type RegulationMeta = {
  id: string;
  name: string;
  nameDe?: string;
  shortName: string;
  jurisdiction: string;
};

const ALL = 'Alle';

const JURISDICTIONS = [ALL, 'EU', 'CH', 'DE', 'INTL'] as const;

const BINDING_LEVELS = [ALL, 'Verpflichtend', 'Aufsichtsrechtlich', 'Best Practice'] as const;
const BINDING_VALUES: Record<string, string> = {
  Verpflichtend: 'mandatory',
  Aufsichtsrechtlich: 'supervisory_expectation',
  'Best Practice': 'best_practice',
};

const AUDIENCES = [ALL, 'Anbieter', 'Betreiber', 'Behörde'] as const;
const AUDIENCE_VALUES: Record<string, string> = {
  Anbieter: 'provider',
  Betreiber: 'deployer',
  'Behörde': 'authority',
};

const CATEGORIES = [
  ALL, 'Governance', 'Risikomanagement', 'Daten', 'Transparenz',
  'Sicherheit', 'Monitoring', 'Dokumentation', 'Drittanbieter', 'Rechte', 'Verboten',
] as const;
const CATEGORY_VALUES: Record<string, string> = {
  Governance: 'governance',
  Risikomanagement: 'risk-management',
  Daten: 'data',
  Transparenz: 'transparency',
  Sicherheit: 'security',
  Monitoring: 'monitoring',
  Dokumentation: 'documentation',
  Drittanbieter: 'third-party',
  Rechte: 'rights',
  Verboten: 'prohibited-practices',
};

const RELEVANCES = [ALL, 'Kritisch', 'Hoch', 'Mittel', 'Niedrig'] as const;
const RELEVANCE_VALUES: Record<string, string> = {
  Kritisch: 'critical',
  Hoch: 'high',
  Mittel: 'medium',
  Niedrig: 'low',
};

const BINDING_BADGES: Record<string, string> = {
  mandatory: 'bg-red-600 text-white',
  supervisory_expectation: 'bg-yellow-500 text-black',
  best_practice: 'bg-blue-500 text-white',
};
const BINDING_LABELS: Record<string, string> = {
  mandatory: 'Verpflichtend',
  supervisory_expectation: 'Aufsichtsrechtlich',
  best_practice: 'Best Practice',
};
const RELEVANCE_LABELS: Record<string, string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

const RELEVANCE_COLORS: Record<string, string> = {
  critical: 'bg-risk-high text-white',
  high: 'bg-risk-limited text-black',
  medium: 'bg-brand-yellow text-black',
  low: 'bg-text-secondary/20 text-text-secondary',
};

const BINDING_SORT_ORDER: Record<string, number> = {
  mandatory: 0,
  supervisory_expectation: 1,
  best_practice: 2,
};

export function KBBrowser({
  requirements,
  regulations,
}: {
  requirements: Requirement[];
  regulations: RegulationMeta[];
}) {
  const [query, setQuery] = useState('');
  const [jurisdiction, setJurisdiction] = useState<string>(ALL);
  const [bindingLevel, setBindingLevel] = useState<string>(ALL);
  const [audience, setAudience] = useState<string>(ALL);
  const [category, setCategory] = useState<string>(ALL);
  const [relevance, setRelevance] = useState<string>(ALL);

  const activeFilterCount = [jurisdiction, bindingLevel, audience, category, relevance].filter(
    (f) => f !== ALL,
  ).length;

  const filtered = useMemo(() => {
    let result = requirements;
    if (jurisdiction !== ALL) {
      result = result.filter((r) => r.jurisdiction.includes(jurisdiction));
    }
    if (bindingLevel !== ALL) {
      const val = BINDING_VALUES[bindingLevel];
      result = result.filter((r) => r.bindingLevel === val);
    }
    if (audience !== ALL) {
      const val = AUDIENCE_VALUES[audience];
      result = result.filter(
        (r) => r.audience.includes(val) || r.audience.includes('all'),
      );
    }
    if (category !== ALL) {
      const val = CATEGORY_VALUES[category];
      result = result.filter((r) => r.category === val);
    }
    if (relevance !== ALL) {
      const val = RELEVANCE_VALUES[relevance];
      result = result.filter((r) => r.relevanceForFinancialSector === val);
    }
    if (query) {
      const q = query.toLowerCase();
      result = result.filter(
        (r) =>
          (r.titleDe ?? '').toLowerCase().includes(q) ||
          (r.summaryDe ?? '').toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          r.title.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    // Sort: mandatory first
    return [...result].sort(
      (a, b) => (BINDING_SORT_ORDER[a.bindingLevel] ?? 9) - (BINDING_SORT_ORDER[b.bindingLevel] ?? 9)
    );
  }, [requirements, query, jurisdiction, bindingLevel, audience, category, relevance]);

  const grouped = useMemo(() => {
    const map = new Map<string, Requirement[]>();
    for (const r of filtered) {
      const list = map.get(r.regulation) || [];
      list.push(r);
      map.set(r.regulation, list);
    }
    return map;
  }, [filtered]);

  const regMeta = useMemo(() => {
    const map = new Map<string, RegulationMeta>();
    for (const r of regulations) map.set(r.id, r);
    return map;
  }, [regulations]);

  function FilterRow({ label, items, value, onChange }: {
    label: string;
    items: readonly string[];
    value: string;
    onChange: (v: string) => void;
  }) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-secondary w-24 shrink-0">{label}</span>
        <div className="flex gap-1.5 flex-wrap">
          {items.map((item) => (
            <button
              key={item}
              onClick={() => onChange(item)}
              className={`px-2.5 py-0.5 text-xs rounded-md border transition-colors ${
                value === item
                  ? 'bg-brand-primary text-black border-brand-primary'
                  : 'bg-surface border-border-brand text-text-secondary hover:border-brand-primary'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Suche */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Anforderungen nach ID, Titel, Zusammenfassung oder Tag suchen..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full px-4 py-2 bg-surface border border-border-brand rounded-md text-foreground placeholder:text-text-secondary focus:outline-none focus:border-brand-primary"
        />
      </div>

      {/* Filter */}
      <div className="mb-8 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-text-secondary">
          Filter
        </div>
        <FilterRow label="Pflichtgrad" items={BINDING_LEVELS} value={bindingLevel} onChange={setBindingLevel} />
        <FilterRow label="Jurisdiktion" items={JURISDICTIONS} value={jurisdiction} onChange={setJurisdiction} />
        <FilterRow label="Zielgruppe" items={AUDIENCES} value={audience} onChange={setAudience} />
        <FilterRow label="Kategorie" items={CATEGORIES} value={category} onChange={setCategory} />
        <FilterRow label="Relevanz" items={RELEVANCES} value={relevance} onChange={setRelevance} />

        <div className="text-sm text-text-secondary">
          {filtered.length} Ergebnisse
          {activeFilterCount > 0 && (
            <span className="ml-1 text-brand-primary">
              ({activeFilterCount} Filter aktiv)
            </span>
          )}
        </div>
      </div>

      {/* Grouped requirements */}
      {Array.from(grouped.entries()).map(([regId, reqs]) => {
        const meta = regMeta.get(regId);
        return (
          <div key={regId} className="mb-10">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-xl font-bold font-heading">
                {meta?.shortName || regId}
              </h2>
              <span className="px-2 py-0.5 text-xs bg-brand-primary/10 text-brand-primary rounded-full">
                {reqs.length}
              </span>
              {meta?.jurisdiction && (
                <span className="px-2 py-0.5 text-xs border border-border-brand text-text-secondary rounded">
                  {meta.jurisdiction}
                </span>
              )}
            </div>

            <div className="grid gap-4">
              {reqs.map((req) => (
                <Link
                  key={req.id}
                  href={`/kb/${req.id}`}
                  className="block p-4 bg-surface border border-border-brand rounded-lg hover:border-brand-primary transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <span className="shrink-0 px-2 py-0.5 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">
                      {req.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-bold truncate">{req.titleDe ?? req.title}</h3>
                        {/* Binding level badge */}
                        <span className={`shrink-0 px-2 py-0.5 text-xs rounded ${BINDING_BADGES[req.bindingLevel] || ''}`}>
                          {BINDING_LABELS[req.bindingLevel] || req.bindingLevel}
                        </span>
                        {/* Relevance indicator */}
                        <span className={`shrink-0 px-2 py-0.5 text-xs rounded ${RELEVANCE_COLORS[req.relevanceForFinancialSector] || ''}`}>
                          {RELEVANCE_LABELS[req.relevanceForFinancialSector] ?? req.relevanceForFinancialSector}
                        </span>
                        {req.verified ? (
                          <span className="shrink-0 text-risk-minimal text-xs" title="Verifiziert">&#10003;</span>
                        ) : (
                          <span className="shrink-0 text-risk-limited text-xs" title="Noch nicht verifiziert">&#9888;</span>
                        )}
                      </div>
                      <p className="text-sm text-text-secondary line-clamp-2">{req.summaryDe ?? req.summary}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {req.jurisdiction.map((j) => (
                          <span key={j} className="px-1.5 py-0.5 text-xs border border-border-brand text-text-secondary rounded">{j}</span>
                        ))}
                        {req.audience.map((a) => (
                          <span key={a} className="px-1.5 py-0.5 text-xs border border-brand-primary/30 text-brand-primary rounded">
                            {label(AUDIENCE_LABELS, a)}
                          </span>
                        ))}
                        <span className="px-1.5 py-0.5 text-xs bg-brand-secondary/10 text-brand-secondary rounded">
                          {label(CATEGORY_LABELS, req.category)}
                        </span>
                        {req.controls.length > 0 && (
                          <span className="px-1.5 py-0.5 text-xs bg-brand-primary/10 text-brand-primary rounded">
                            {req.controls.length} {req.controls.length === 1 ? 'Control' : 'Controls'}
                          </span>
                        )}
                        <span className="ml-1 text-xs text-text-secondary">{req.article}</span>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}

      {grouped.size === 0 && (
        <p className="text-center text-text-secondary py-12">
          Keine Anforderungen entsprechen Ihrer Suche.
        </p>
      )}
    </div>
  );
}
