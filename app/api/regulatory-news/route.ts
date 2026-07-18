import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { decodeStrList } from '@/lib/db-json';
import { JURISDICTIONS } from '@/lib/regulatory/types';

/**
 * Public regulatory news feed — visible to all users (no auth). Supports
 * filtering by jurisdiction (EU/DE/CH/INTL) and by a single tag.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jurisdiction = searchParams.get('jurisdiction');
  const tag = searchParams.get('tag');

  const where: { jurisdiction?: (typeof JURISDICTIONS)[number] } = {};
  if (jurisdiction && (JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    where.jurisdiction = jurisdiction as (typeof JURISDICTIONS)[number];
  }

  try {
    const rows = await db.regulatoryNewsItem.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    // tags is a JSON-encoded string column; decode and (optionally) filter in app.
    const items = rows
      .map((r) => ({ ...r, tags: decodeStrList(r.tags) }))
      .filter((r) => !tag || r.tags.includes(tag));
    return NextResponse.json({ items });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'regulatory_news_list_failed', detail: err instanceof Error ? err.message : String(err) }),
    );
    return NextResponse.json({ items: [] });
  }
}
