import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { db } from '@/lib/db';

/** List all memory facts for the authenticated user. */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  const facts = await db.memoryFact.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: 'desc' },
  });

  const parsed = facts.map((f) => ({
    id: f.id,
    content: f.content,
    tags: JSON.parse(f.tags) as string[],
    category: f.category,
    status: f.status,
    importance: f.importance,
    sourceConversationId: f.sourceConversationId,
    supersededFactId: f.supersededFactId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));

  const counts = {
    active: parsed.filter((f) => f.status === 'active').length,
    superseded: parsed.filter((f) => f.status === 'superseded').length,
    archived: parsed.filter((f) => f.status === 'archived').length,
    total: parsed.length,
  };

  return NextResponse.json({ facts: parsed, counts });
}
