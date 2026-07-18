import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';

/** Lightweight status payload (incl. translation fields) for polling. */
function statusPayload(doc: NonNullable<Awaited<ReturnType<typeof db.regulatoryDocument.findUnique>>> | null) {
  if (!doc) return null;
  return {
    id: doc.id,
    title: doc.title,
    regulation: doc.regulation,
    status: doc.status,
    error: doc.error,
    documentUrl: doc.documentUrl,
    sourceUrl: doc.sourceUrl,
    isTranslation: doc.isTranslation,
    originalLanguage: doc.originalLanguage,
    targetLanguage: doc.targetLanguage,
    translationStatus: doc.translationStatus,
    originalDocumentId: doc.originalDocumentId,
    qualityWarnings: doc.qualityWarnings ?? null,
  };
}

/**
 * Regulatory documents API.
 *  - No params → PUBLIC list of INGESTED documents for the Bibliothek.
 *  - `?id=` → PUBLIC status lookup for one document (Bibliothek docs are public;
 *    used by the AEGIS Translate UI to poll translation progress).
 *  - `?suggestionId=` → ADMIN status lookup, used by the KB-suggestion review UI
 *    to poll ingestion progress.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const suggestionId = searchParams.get('suggestionId');
  const id = searchParams.get('id');

  // Public single-document status (regulatory docs are public).
  if (id) {
    const doc = await db.regulatoryDocument.findUnique({ where: { id } });
    return NextResponse.json({ document: statusPayload(doc) });
  }

  // Admin status lookup by suggestion (ingestion progress in the review UI).
  if (suggestionId) {
    const user = await getUserFromCookies();
    if (!requireAdmin(user)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const doc = await db.regulatoryDocument.findFirst({
      where: { suggestionId },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ document: statusPayload(doc) });
  }

  // Public Bibliothek list.
  try {
    const docs = await db.regulatoryDocument.findMany({
      where: { status: 'INGESTED' },
      orderBy: { fetchedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        title: true,
        regulation: true,
        jurisdiction: true,
        sourceName: true,
        sourceUrl: true,
        documentUrl: true,
        fetchedAt: true,
        originalLanguage: true,
        isTranslation: true,
        originalDocumentId: true,
        targetLanguage: true,
      },
    });
    return NextResponse.json({ items: docs });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'regulatory_documents_list_failed', detail: err instanceof Error ? err.message : String(err) }),
    );
    return NextResponse.json({ items: [] });
  }
}
