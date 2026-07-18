import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { JURISDICTIONS } from '@/lib/regulatory/types';

/**
 * Public regulatory news feed — visible to all users (no auth). Supports
 * filtering by jurisdiction (EU/DE/CH/INTL) and by a single tag.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jurisdiction = searchParams.get('jurisdiction');
  const tag = searchParams.get('tag');

  const where: {
    jurisdiction?: (typeof JURISDICTIONS)[number];
    tags?: { has: string };
  } = {};
  if (jurisdiction && (JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    where.jurisdiction = jurisdiction as (typeof JURISDICTIONS)[number];
  }
  if (tag) where.tags = { has: tag };

  try {
    const items = await db.regulatoryNewsItem.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return NextResponse.json({ items });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'regulatory_news_list_failed', detail: err instanceof Error ? err.message : String(err) }),
    );
    return NextResponse.json({ items: [] });
  }
}
