import { db } from '@/lib/db';
import { decodeStrList } from '@/lib/db-json';

/**
 * Read-only retrieval of regulatory-radar news items for the optional
 * "Regulatorischer Ausblick" section in AEGIS decks (PPTX) and gap registers
 * (Excel). News items are produced by the daily radar and are source-verified
 * (every row carries a real `sourceUrl`) — we only ECHO them, never invent or
 * re-rate them, so this stays inside AEGIS's anti-hallucination contract.
 *
 * Matching mirrors the news-feed UI exactly (case-insensitive substring on
 * `tags`), so the deck/Excel show the same items a user would see by filtering
 * the feed to the regulations the deliverable covers. The pure selection logic
 * (`selectOutlook`) is split from the DB call so it can be unit-tested without a
 * database.
 */

export type OutlookItem = {
  title: string;
  summary: string;
  relevance: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: Date | null;
  jurisdiction: string;
  tags: string[];
};

/** A news row as returned by Prisma (the fields we read). */
type NewsRow = {
  title: string;
  summary: string;
  relevance: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt: Date | null;
  jurisdiction: string;
  tags: string[];
  createdAt: Date;
};

// Each family maps the regulation NAMES that flow in from gap findings (display
// short names like "EU AI Act", "GDPR") AND their KB enum forms (e.g.
// "EU_AI_ACT") onto the lowercase tag substrings the radar actually emits.
// Basis: the TAG_FILTERS in components/RegulatoryNewsFeed.tsx — kept aligned so
// the deck/Excel and the feed agree on what "DORA news" means.
const NEWS_TERM_FAMILIES: { triggers: string[]; terms: string[] }[] = [
  { triggers: ['dora'], terms: ['dora'] },
  {
    triggers: ['ai act', 'ai_act', 'aiact', 'ki-verordnung', 'ki verordnung'],
    terms: ['ai act', 'ki-verordnung', 'ki verordnung'],
  },
  { triggers: ['nis2', 'nis 2'], terms: ['nis2', 'nis 2'] },
  {
    triggers: ['gdpr', 'dsgvo', 'datenschutz', 'bdsg', 'revdsg', 'fadp'],
    terms: ['datenschutz', 'gdpr', 'dsgvo', 'fadp', 'revdsg'],
  },
  { triggers: ['cra', 'cyber resilience'], terms: ['cra', 'cyber resilience'] },
  { triggers: ['dsa', 'digital services'], terms: ['dsa', 'digital services'] },
  { triggers: ['data act'], terms: ['data act'] },
];

/**
 * Map a single regulation (display short name OR KB enum) to the lowercase tag
 * substrings that identify its news. Falls back to the normalised name + its
 * first token so an unmapped regulation still matches a literal tag if present.
 */
export function regulationNewsTerms(regulation: string): string[] {
  const n = regulation.toLowerCase().replace(/_/g, ' ').trim();
  const terms = new Set<string>();
  for (const fam of NEWS_TERM_FAMILIES) {
    if (fam.triggers.some((t) => n.includes(t))) fam.terms.forEach((t) => terms.add(t));
  }
  if (terms.size === 0 && n) {
    terms.add(n);
    const first = n.split(/\s+/)[0];
    if (first && first !== n) terms.add(first);
  }
  return [...terms];
}

/** Union of news terms for a set of covered regulations. */
export function newsTermsForRegulations(regulations: string[]): string[] {
  const terms = new Set<string>();
  for (const r of regulations) for (const t of regulationNewsTerms(r)) terms.add(t);
  return [...terms];
}

/** True when any of the item's tags contains any of the match terms (feed parity). */
export function matchesTerms(tags: string[], terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = tags.map((t) => t.toLowerCase());
  return terms.some((term) => lower.some((tag) => tag.includes(term)));
}

export type OutlookSelect = {
  /** Covered regulations (display names or enums). Empty → no outlook (covered-only scope). */
  regulations: string[];
  /** Only items published/created within this many days. Default 180. */
  sinceDays?: number;
  /** Max items returned. Default 6. */
  limit?: number;
  /** Injectable clock for deterministic tests. Default now. */
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function effectiveDate(row: NewsRow): Date {
  return row.publishedAt ?? row.createdAt;
}

/**
 * Pure selection: filter rows to the covered regulations, keep only recent ones,
 * sort newest-first, cap at `limit`. No DB access — unit-testable.
 */
export function selectOutlook(rows: NewsRow[], opts: OutlookSelect): OutlookItem[] {
  const terms = newsTermsForRegulations(opts.regulations);
  if (terms.length === 0) return [];
  const sinceDays = opts.sinceDays ?? 180;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - sinceDays * DAY_MS;
  const limit = opts.limit ?? 6;

  return rows
    .filter((r) => matchesTerms(r.tags, terms) && effectiveDate(r).getTime() >= cutoff)
    .sort((a, b) => effectiveDate(b).getTime() - effectiveDate(a).getTime())
    .slice(0, limit)
    .map((r) => ({
      title: r.title,
      summary: r.summary,
      relevance: r.relevance,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      publishedAt: r.publishedAt,
      jurisdiction: r.jurisdiction,
      tags: r.tags,
    }));
}

/**
 * Fetch the regulatory outlook for the regulations a deliverable covers. Returns
 * [] when no regulations are supplied (covered-only scope) or nothing matches.
 */
export async function getRegulatoryOutlook(opts: OutlookSelect): Promise<OutlookItem[]> {
  if (newsTermsForRegulations(opts.regulations).length === 0) return [];
  const rows = await db.regulatoryNewsItem.findMany({
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  return selectOutlook(
    rows.map((r) => ({ ...r, tags: decodeStrList(r.tags) })) as NewsRow[],
    opts,
  );
}
