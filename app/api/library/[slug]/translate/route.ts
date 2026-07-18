import { NextResponse, after, type NextRequest } from 'next/server';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { SOURCE_FILES } from '@/lib/library/sources';
import { isTranslationConfigured } from '@/lib/translate/deepl';
import { isSupportedTarget } from '@/lib/translate/targets';
import { createBundledTranslationJob, runRegulatoryTranslation } from '@/lib/translate/translate-regulatory';

export const maxDuration = 300;

/**
 * Translate a BUNDLED library law (docs/source/*.txt) into any supported DeepL
 * target. Creates a machine-translated RegulatoryDocument (idempotent per
 * slug+target) that appears in the Bibliothek and is searchable by AEGIS —
 * never curates the KB. Async via after(); the client polls the status.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
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

  const { slug } = await params;
  if (!SOURCE_FILES[slug]) {
    return NextResponse.json({ error: 'not_found', message: `Unbekanntes Gesetz: ${slug}` }, { status: 404 });
  }

  let body: { target?: string };
  try {
    body = (await req.json()) as { target?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  const target = (body.target ?? '').toUpperCase();
  if (!isSupportedTarget(target)) {
    return NextResponse.json({ error: 'invalid_input', message: 'Nicht unterstützte Zielsprache.' }, { status: 400 });
  }

  try {
    const job = await createBundledTranslationJob(slug, target, user.email);
    if (!(job.alreadyExisted && job.status === 'INGESTED')) {
      after(async () => {
        try {
          await runRegulatoryTranslation(job.documentId, target);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: 'bundled_translation_failed',
              slug,
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    }
    return NextResponse.json({ documentId: job.documentId, status: job.status, alreadyExisted: job.alreadyExisted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'translation_error';
    return NextResponse.json({ error: msg }, { status: msg === 'translation_source_not_found' ? 404 : 400 });
  }
}
