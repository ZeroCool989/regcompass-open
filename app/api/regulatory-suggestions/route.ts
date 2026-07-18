import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';

const STATUSES = ['PROPOSED', 'ACCEPTED', 'REJECTED'] as const;

/** Admin-only: list internal KB-update suggestions (optionally by status). */
export async function GET(req: NextRequest) {
  const user = await getUserFromCookies();
  if (!requireAdmin(user)) {
    return NextResponse.json({ error: 'forbidden', message: 'Nur für Admins.' }, { status: 403 });
  }

  const status = new URL(req.url).searchParams.get('status');
  const where = status && (STATUSES as readonly string[]).includes(status)
    ? { status: status as (typeof STATUSES)[number] }
    : {};

  const items = await db.regulatoryKbSuggestion.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
  return NextResponse.json({ items });
}
