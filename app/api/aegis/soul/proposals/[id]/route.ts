import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { acceptProposal, rejectProposal } from '@/lib/aegis/soul-store';

/**
 * Decide a pending soul proposal: accept (store as-is), edit (store edited
 * content — re-firewalled), or reject. Only the user can call this; the AI
 * never reaches SoulEntry.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Bad JSON.' }, { status: 400 });
  }
  const action = String((body as { action?: unknown })?.action ?? '');
  const content = (body as { content?: unknown })?.content;
  // When resolving a contradiction/duplicate "new wins", the id of the existing
  // entry to archive (must match the conflicting entry the 409 reported).
  const archiveConflictId = (body as { archiveConflictId?: unknown })?.archiveConflictId;
  const archiveId = typeof archiveConflictId === 'string' ? archiveConflictId : undefined;

  let res;
  if (action === 'accept') {
    res = await acceptProposal(user.id, id, undefined, archiveId);
  } else if (action === 'edit') {
    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'Bearbeiteter Inhalt fehlt.' },
        { status: 400 },
      );
    }
    res = await acceptProposal(user.id, id, content, archiveId);
  } else if (action === 'reject') {
    res = await rejectProposal(user.id, id);
  } else {
    return NextResponse.json(
      { error: 'invalid_action', message: 'Aktion muss accept, edit oder reject sein.' },
      { status: 400 },
    );
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: res.error, message: res.message, conflict: res.conflict },
      { status: res.status },
    );
  }
  return NextResponse.json({ ok: true });
}
