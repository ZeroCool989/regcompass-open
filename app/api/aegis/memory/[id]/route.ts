import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { db } from '@/lib/db';
import { extractRegulationTags } from '@/lib/aegis/cross-memory';

async function requireUser(req: NextRequest) {
  const user = await getUserFromRequest(req);
  return user ?? null;
}

const UNAUTH = NextResponse.json(
  { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
  { status: 401 },
);

/** Transition a fact: archive | restore | edit. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser(req);
  if (!user) return UNAUTH;

  const fact = await db.memoryFact.findFirst({ where: { id, userId: user.id } });
  if (!fact) {
    return NextResponse.json(
      { error: 'not_found', message: 'Fakt nicht gefunden.' },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Bad JSON.' }, { status: 400 });
  }

  const action = String((body as { action?: unknown })?.action ?? '');

  if (action === 'archive') {
    await db.memoryFact.update({ where: { id }, data: { status: 'archived' } });
    return NextResponse.json({ ok: true });
  }

  if (action === 'restore') {
    await db.memoryFact.update({ where: { id }, data: { status: 'active' } });
    return NextResponse.json({ ok: true });
  }

  if (action === 'edit') {
    const content = String((body as { content?: unknown })?.content ?? '').trim();
    if (!content) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'Inhalt darf nicht leer sein.' },
        { status: 400 },
      );
    }
    const tags = extractRegulationTags(content);
    await db.memoryFact.update({
      where: { id },
      data: { content, tags: JSON.stringify(tags) },
    });
    return NextResponse.json({ ok: true, tags });
  }

  return NextResponse.json(
    { error: 'invalid_action', message: 'Aktion muss archive, restore oder edit sein.' },
    { status: 400 },
  );
}

/** Hard-delete a memory fact (user data sovereignty). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await requireUser(req);
  if (!user) return UNAUTH;

  const fact = await db.memoryFact.findFirst({ where: { id, userId: user.id } });
  if (!fact) {
    return NextResponse.json(
      { error: 'not_found', message: 'Fakt nicht gefunden.' },
      { status: 404 },
    );
  }

  await db.memoryFact.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
