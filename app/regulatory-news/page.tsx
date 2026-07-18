import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { RegulatoryNewsFeed, type NewsDto } from '@/components/RegulatoryNewsFeed';
import { KbSuggestionReview, type SuggestionDto } from '@/components/KbSuggestionReview';

export const dynamic = 'force-dynamic';

export default async function RegulatoryNewsPage() {
  let newsDto: NewsDto[] = [];
  try {
    const news = await db.regulatoryNewsItem.findMany({
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    newsDto = news.map((n) => ({
      id: n.id,
      title: n.title,
      summary: n.summary,
      relevance: n.relevance,
      sourceName: n.sourceName,
      sourceUrl: n.sourceUrl,
      publishedAt: n.publishedAt ? n.publishedAt.toISOString() : null,
      jurisdiction: n.jurisdiction,
      tags: n.tags,
    }));
  } catch {
    newsDto = []; // table not migrated yet / DB hiccup — render an empty feed, never crash
  }

  const user = await getUserFromCookies();
  const isAdmin = requireAdmin(user);

  let suggestionDto: SuggestionDto[] = [];
  if (isAdmin) {
    try {
      const suggestions = await db.regulatoryKbSuggestion.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 200,
      });
      // Attach the linked ingestion document (status badge + manual fallback)
      // for accepted suggestions.
      const acceptedIds = suggestions.filter((s) => s.status === 'ACCEPTED').map((s) => s.id);
      const docs = acceptedIds.length
        ? await db.regulatoryDocument.findMany({
            where: { suggestionId: { in: acceptedIds } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, suggestionId: true, status: true, error: true, documentUrl: true, sourceUrl: true, originalLanguage: true },
          })
        : [];
      const docBySuggestion = new Map<string, (typeof docs)[number]>();
      for (const d of docs) if (d.suggestionId && !docBySuggestion.has(d.suggestionId)) docBySuggestion.set(d.suggestionId, d);

      suggestionDto = suggestions.map((s) => {
        const doc = docBySuggestion.get(s.id);
        return {
          id: s.id,
          sourceName: s.sourceName,
          sourceUrl: s.sourceUrl,
          regulation: s.regulation,
          proposedRequirementId: s.proposedRequirementId,
          proposedRequirementText: s.proposedRequirementText,
          relevanceForFinancialSector: s.relevanceForFinancialSector,
          bindingLevel: s.bindingLevel,
          rationale: s.rationale,
          status: s.status,
          reviewedBy: s.reviewedBy,
          document: doc
            ? { id: doc.id, status: doc.status, error: doc.error, documentUrl: doc.documentUrl, sourceUrl: doc.sourceUrl, originalLanguage: doc.originalLanguage }
            : null,
        };
      });
    } catch {
      suggestionDto = [];
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-foreground">Regulatorik News</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Täglich aktualisierte regulatorische Entwicklungen für KI im Finanzsektor (EU · Deutschland ·
          Schweiz). Jeder Eintrag ist mit einer offiziellen Quelle belegt.
        </p>
      </header>

      <RegulatoryNewsFeed items={newsDto} />

      {isAdmin && (
        <section className="mt-12 border-t border-white/10 pt-8">
          <h2 className="text-lg font-semibold text-foreground">
            KB-Vorschläge <span className="text-text-secondary">(nur Admin)</span>
          </h2>
          <p className="mb-4 mt-1 text-sm text-text-secondary">
            Vorschläge für neue/​geänderte Anforderungen. <strong>Nichts wird automatisch</strong> in die
            produktive Wissensdatenbank geschrieben — Annehmen markiert nur den geprüften Entwurf.
          </p>
          <KbSuggestionReview initial={suggestionDto} />
        </section>
      )}
    </main>
  );
}
