import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { isTranslationConfigured } from '@/lib/translate/deepl';
import { detectRegulatoryLanguage } from '@/lib/translate/translate-regulatory';

export const maxDuration = 30;

/**
 * Detect + cache the source language of a RegulatoryDocument (lazy backfill for
 * docs ingested before detection existed). Admin-only (uses a DeepL sample) —
 * translation is an admin capability.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromCookies();
  if (!requireAdmin(user)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!isTranslationConfigured()) {
    return NextResponse.json({ error: 'deepl_not_configured' }, { status: 503 });
  }
  const { id } = await params;
  try {
    const language = await detectRegulatoryLanguage(id);
    return NextResponse.json({ language });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'detect_failed' },
      { status: 500 },
    );
  }
}
