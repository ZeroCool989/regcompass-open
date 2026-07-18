import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { revokeEntry, transitionEntry } from '@/lib/aegis/soul-store';

async function requireUser(req: NextRequest) {
  const user = await getUserFromRequest(req);
  return user ?? null;
}

const UNAUTH = NextResponse.json(
  { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
  { status: 401 },
);

/** Lifecycle transition: confirm (re-freshen) | archive | restore. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser(req);
  if (!user) return UNAUTH;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Bad JSON.' }, { status: 400 });
  }
  const action = String((body as { action?: unknown })?.action ?? '');
  if (action !== 'confirm' && action !== 'archive' && action !== 'restore') {
    return NextResponse.json(
      { error: 'invalid_action', message: 'Aktion muss confirm, archive oder restore sein.' },
      { status: 400 },
    );
  }
  const res = await transitionEntry(user.id, id, action);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, message: res.message }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}

/** Hard-remove an approved soul entry. User-only; writes an audit row. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser(req);
  if (!user) return UNAUTH;
  const res = await revokeEntry(user.id, id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, message: res.message }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
