'use client';

import { useState, useMemo } from 'react';
import { GLOSSARY, CATEGORY_LABELS, type GlossaryEntry } from '@/lib/glossary';

const CATEGORIES = ['regulation', 'institution', 'concept', 'acronym'] as const;
type CatFilter = 'all' | GlossaryEntry['category'];

export default function GlossarPage() {
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<CatFilter>('all');

  const entries = useMemo(() => {
    const all = Object.entries(GLOSSARY)
      .map(([term, entry]) => ({ term, ...entry }))
      .sort((a, b) => a.term.localeCompare(b.term, 'de'));

    return all.filter((e) => {
      if (catFilter !== 'all' && e.category !== catFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          e.term.toLowerCase().includes(q) ||
          e.de.toLowerCase().includes(q) ||
          e.en.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [search, catFilter]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof entries>();
    for (const cat of CATEGORIES) {
      const items = entries.filter((e) => e.category === cat);
      if (items.length > 0) m.set(cat, items);
    }
    return m;
  }, [entries]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold font-heading tracking-tight mb-2">
            Regulatorisches Glossar
          </h1>
          <p className="text-text-secondary">
            {Object.keys(GLOSSARY).length} Fachbegriffe aus der KI-Regulatorik — Deutsch und Englisch.
          </p>
        </header>

        <div className="flex flex-wrap gap-3 mb-6">
          <input
            type="text"
            placeholder="Begriff suchen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[200px] px-4 py-2 bg-surface border border-border-brand rounded-lg text-foreground placeholder:text-text-secondary focus:outline-none focus:border-brand-primary text-sm"
          />
          <div className="flex gap-1.5">
            <FilterButton active={catFilter === 'all'} onClick={() => setCatFilter('all')} label="Alle" />
            {CATEGORIES.map((cat) => (
              <FilterButton
                key={cat}
                active={catFilter === cat}
                onClick={() => setCatFilter(cat)}
                label={CATEGORY_LABELS[cat]}
              />
            ))}
          </div>
        </div>

        {entries.length === 0 && (
          <p className="text-center text-text-secondary py-12">Keine Begriffe gefunden.</p>
        )}

        {catFilter === 'all' ? (
          Array.from(grouped.entries()).map(([cat, items]) => (
            <section key={cat} className="mb-8">
              <h2 className="text-lg font-semibold font-heading mb-3 flex items-center gap-2">
                <span className="px-2 py-0.5 text-[0.65rem] font-mono rounded bg-brand-primary/10 text-brand-primary border border-brand-primary/30">
                  {CATEGORY_LABELS[cat as GlossaryEntry['category']]}
                </span>
                <span className="text-xs text-text-secondary font-normal">{items.length}</span>
              </h2>
              <div className="space-y-1">
                {items.map((e) => (
                  <GlossaryRow key={e.term} term={e.term} de={e.de} en={e.en} />
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="space-y-1">
            {entries.map((e) => (
              <GlossaryRow key={e.term} term={e.term} de={e.de} en={e.en} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function FilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors ${
        active
          ? 'border-brand-primary bg-brand-primary/15 text-brand-primary'
          : 'border-border-brand text-text-secondary hover:border-brand-primary/50'
      }`}
    >
      {label}
    </button>
  );
}

function GlossaryRow({ term, de, en }: { term: string; de: string; en: string }) {
  return (
    <details className="group rounded-lg border border-border-brand/60 bg-surface/30 hover:border-border-brand transition-colors">
      <summary className="px-4 py-3 cursor-pointer flex items-center gap-3 text-sm">
        <span className="font-semibold text-foreground">{term}</span>
        <span className="flex-1 text-text-secondary/70 text-xs truncate hidden sm:block">{de.slice(0, 80)}...</span>
        <span className="text-[0.6rem] text-text-secondary/50 group-open:rotate-90 transition-transform">&#9654;</span>
      </summary>
      <div className="px-4 pb-3 pt-0">
        <p className="text-sm text-text-secondary leading-relaxed">{de}</p>
        <p className="text-xs text-text-secondary/60 mt-1.5 italic">{en}</p>
      </div>
    </details>
  );
}
