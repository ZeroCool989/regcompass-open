import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';

/**
 * Public download of an INGESTED RegulatoryDocument as TXT or Markdown.
 * `?format=txt` serves the plaintext `rawText`; `?format=md` serves the
 * `markdown` (which carries the provenance / machine-translated header).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get('format') === 'md' ? 'md' : 'txt';

  const doc = await db.regulatoryDocument.findUnique({ where: { id } });
  if (!doc || doc.status !== 'INGESTED') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body = (format === 'md' ? doc.markdown : doc.rawText) ?? '';
  const safeName = doc.title.replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().slice(0, 120) || 'dokument';
  const mime = format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';

  return new Response(body, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${safeName}.${format}"`,
    },
  });
}
