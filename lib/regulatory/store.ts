import { db } from '@/lib/db';
import { encodeStrList } from '@/lib/db-json';
import { newsDedupeKey, suggestionDedupeKey } from './dedupe';
import { OFFICIAL_SOURCES } from './sources';
import { defaultResearchProvider, type RegulatoryResearchProvider } from './research';
import type { KbSuggestion, NewsItem } from './types';

/** Prisma unique-constraint violation (duplicate dedupeKey). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
}

/** Upsert the trusted source registry (idempotent). */
export async function ensureSources(): Promise<void> {
  for (const s of OFFICIAL_SOURCES) {
    await db.regulatorySource
      .upsert({
        where: { name: s.name },
        update: { url: s.url, jurisdiction: s.jurisdiction },
        create: { name: s.name, url: s.url, jurisdiction: s.jurisdiction },
      })
      .catch(() => {
        /* source registry is non-critical — never fail the run over it */
      });
  }
}

/** Insert new news items (dedup via unique key). Returns the count of NEW rows. */
export async function saveNewsItems(items: NewsItem[]): Promise<number> {
  let created = 0;
  for (const i of items) {
    try {
      await db.regulatoryNewsItem.create({
        data: {
          title: i.title,
          summary: i.summary,
          relevance: i.relevance,
          sourceName: i.sourceName,
          sourceUrl: i.sourceUrl,
          publishedAt: i.publishedAt ? new Date(i.publishedAt) : null,
          jurisdiction: i.jurisdiction,
          tags: encodeStrList(i.tags),
          dedupeKey: newsDedupeKey(i),
        },
      });
      created++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // duplicate → skip; real error → bubble up
    }
  }
  return created;
}

/** Insert new KB suggestions (dedup via unique key). Returns the count of NEW rows. */
export async function saveSuggestions(items: KbSuggestion[]): Promise<number> {
  let created = 0;
  for (const i of items) {
    try {
      await db.regulatoryKbSuggestion.create({
        data: {
          sourceName: i.sourceName,
          sourceUrl: i.sourceUrl,
          regulation: i.regulation,
          proposedRequirementId: i.proposedRequirementId ?? null,
          proposedRequirementText: i.proposedRequirementText,
          relevanceForFinancialSector: i.relevanceForFinancialSector,
          bindingLevel: i.bindingLevel,
          rationale: i.rationale,
          dedupeKey: suggestionDedupeKey(i),
        },
      });
      created++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return created;
}

export type RadarRunSummary = {
  runId: string;
  newsFound: number;
  newsCreated: number;
  suggestionsFound: number;
  suggestionsCreated: number;
  status: 'OK' | 'EMPTY' | 'ERROR';
};

/**
 * Run the daily radar: research → validate → store (deduped) → run-log. Always
 * records a run-log row (started/finished/counts/status). On failure it logs the
 * error to the run-log and rethrows so the cron route returns 500 — but the app
 * itself never crashes (the route wraps this in try/catch).
 */
export async function runRegulatoryRadar(
  provider: RegulatoryResearchProvider = defaultResearchProvider,
): Promise<RadarRunSummary> {
  const run = await db.regulatoryRunLog.create({ data: {} });
  try {
    await ensureSources();
    const result = await provider.research();
    const newsCreated = await saveNewsItems(result.news);
    const suggestionsCreated = await saveSuggestions(result.suggestions);

    const empty = result.news.length === 0 && result.suggestions.length === 0;
    const status: RadarRunSummary['status'] = empty ? 'EMPTY' : 'OK';

    await db.regulatoryRunLog.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        newsFound: result.news.length,
        suggestionsCreated,
        status,
      },
    });

    return {
      runId: run.id,
      newsFound: result.news.length,
      newsCreated,
      suggestionsFound: result.suggestions.length,
      suggestionsCreated,
      status,
    };
  } catch (err) {
    await db.regulatoryRunLog
      .update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          status: 'ERROR',
          error: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000),
        },
      })
      .catch(() => {});
    throw err;
  }
}
