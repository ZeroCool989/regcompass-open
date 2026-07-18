import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { soulSnapshot } from '@/lib/aegis/soul-store';

/** Current user's soul: entries, pending proposals, rendered soul.md, maturity. */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }
  return NextResponse.json(await soulSnapshot(user.id, user.username));
}
