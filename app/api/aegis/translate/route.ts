import { NextResponse, type NextRequest } from 'next/server';
import { getDocument, storeDocument } from '@/lib/aegis/document-store';
import { readSessionId } from '@/lib/session';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { isTranslationConfigured, translateText } from '@/lib/translate/deepl';
import { isSupportedTarget } from '@/lib/translate/targets';
import { reviewTranslation } from '@/lib/translate/quality';

export const maxDuration = 120;

/**
 * Translate an uploaded document (session-scoped AegisDocument) into DE/EN and
 * store the result as a NEW working AegisDocument. The original is preserved.
 * `analyze_document` then uses the translated copy transparently. Synchronous
 * because uploads are capped at ~100 KB. Never curates the KB.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromCookies();
  if (!requireAdmin(user)) {
    return NextResponse.json({ error: 'forbidden', message: 'Nur für Admins.' }, { status: 403 });
  }
  if (!isTranslationConfigured()) {
    return NextResponse.json(
      { error: 'deepl_not_configured', message: 'Übersetzung ist nicht konfiguriert (DEEPL_API_KEY fehlt).' },
      { status: 503 },
    );
  }

  let body: { documentId?: string; target?: string };
  try {
    body = (await req.json()) as { documentId?: string; target?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  const target = (body.target ?? '').toUpperCase();
  if (!body.documentId || !isSupportedTarget(target)) {
    return NextResponse.json({ error: 'invalid_input', message: 'documentId und eine unterstützte Zielsprache erforderlich.' }, { status: 400 });
  }

  const sessionId = readSessionId(req);
  if (!sessionId) {
    return NextResponse.json({ error: 'not_found', message: 'Dokument nicht gefunden.' }, { status: 404 });
  }
  const original = await getDocument(body.documentId, sessionId);
  if (!original || !original.textContent.trim()) {
    return NextResponse.json({ error: 'not_found', message: 'Dokument nicht gefunden.' }, { status: 404 });
  }

  try {
    const { text: translated, detectedSourceLang } = await translateText(original.textContent, target);
    const warnings = reviewTranslation(original.textContent, translated, detectedSourceLang, target);
    const base = original.filename.replace(/\.[^.]+$/, '');
    const filename = `${base} (${target})`;

    const translatedId = await storeDocument(
      { filename, type: 'policy', textContent: translated },
      sessionId,
    );
    await db.aegisDocument.update({
      where: { id: translatedId },
      data: {
        isTranslation: true,
        translatedFromId: body.documentId,
        targetLanguage: target,
        originalLanguage: detectedSourceLang,
        qualityWarnings: warnings,
      },
    });

    return NextResponse.json({
      translatedDocumentId: translatedId,
      filename,
      originalLanguage: detectedSourceLang,
      target,
      warnings,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'aegis_translate_failed', detail: err instanceof Error ? err.message : String(err) }),
    );
    return NextResponse.json({ error: 'translation_failed', message: 'Übersetzung fehlgeschlagen.' }, { status: 500 });
  }
}
