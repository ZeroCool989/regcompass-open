import type { Metadata } from 'next';
import { SOURCE_FILES, REGULATION_IDS, DEFAULT_REGULATION } from '@/lib/library/sources';
import type { SourceFile } from '@/lib/library/types';
import { LibraryShell } from '@/components/library/LibraryShell';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Gesetzesbibliothek — RegCompass',
  description: 'Volltext-Lesen aller Quelldokumente im EUR-Lex-Stil: EU AI Act, DORA, GDPR, FINMA und mehr.',
};

export const dynamic = 'force-dynamic';

/** Runtime radar-ingested documents, surfaced alongside the bundled source files. */
async function loadIngestedLaws(): Promise<SourceFile[]> {
  try {
    const docs = await db.regulatoryDocument.findMany({
      where: { status: 'INGESTED' },
      orderBy: { fetchedAt: 'desc' },
      take: 200,
      select: {
        id: true, title: true, regulation: true, jurisdiction: true, sourceName: true,
        sourceUrl: true, documentUrl: true, originalLanguage: true, isTranslation: true, originalDocumentId: true,
      },
    });
    return docs.map((d) => ({
      regulationId: d.id,
      file: '',
      title: d.title,
      fullTitle: `${d.regulation} — ${d.sourceName}`,
      jurisdiction: d.jurisdiction as SourceFile['jurisdiction'],
      format: 'fallback',
      sourceUrl: d.documentUrl ?? d.sourceUrl,
      ingested: true,
      originalLanguage: d.originalLanguage,
      isTranslation: d.isTranslation,
      originalDocumentId: d.originalDocumentId,
    }));
  } catch {
    return []; // table missing / DB hiccup — never break the Bibliothek
  }
}

export default async function LibraryPage() {
  const bundled = REGULATION_IDS.map((id) => SOURCE_FILES[id]);
  const ingested = await loadIngestedLaws();
  const laws = [...bundled, ...ingested];
  const user = await getUserFromCookies();
  const isAdmin = requireAdmin(user);
  return (
    <main className="h-[calc(100vh-3.5rem)] bg-background text-foreground">
      <LibraryShell laws={laws} defaultLaw={DEFAULT_REGULATION} isAdmin={isAdmin} />
    </main>
  );
}
