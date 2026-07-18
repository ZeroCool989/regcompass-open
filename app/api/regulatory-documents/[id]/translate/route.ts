import { NextResponse, after, type NextRequest } from 'next/server';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { isTranslationConfigured } from '@/lib/translate/deepl';
import { isSupportedTarget } from '@/lib/translate/targets';
import { createRegulatoryTranslationJob, runRegulatoryTranslation } from '@/lib/translate/translate-regulatory';

export const maxDuration = 300;

/**
 * Translate a RegulatoryDocument (library / radar) into DE or EN. Auth-gated
 * because translation costs DeepL credits. Creates/returns the translation row
 * (idempotent per source+target) and runs the actual translation AFTER the
 * response via `after()`; the client polls status. Never curates the KB.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;
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
    const job = await createRegulatoryTranslationJob(id, target, user.email);
    // Only (re)run if the translation isn't already done.
    if (!(job.alreadyExisted && job.status === 'INGESTED')) {
      after(async () => {
        try {
          await runRegulatoryTranslation(job.documentId, target);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: 'regulatory_translation_failed',
              documentId: job.documentId,
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    }
    return NextResponse.json({ documentId: job.documentId, status: job.status, alreadyExisted: job.alreadyExisted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'translation_error';
    const status = msg === 'translation_source_not_found' ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
