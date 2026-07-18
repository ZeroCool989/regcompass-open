import { NextResponse, type NextRequest } from 'next/server';
import { readSessionId } from '@/lib/session';
import { getUserFromRequest } from '@/lib/auth';
import {
  claimSessionConversations,
  deleteAllConversations,
  deleteAllConversationsForUser,
  listConversations,
  listConversationsForUser,
} from '@/lib/aegis/memory';

const ERASE_MESSAGE =
  'Alle Unterhaltungen und Nachrichten wurden endgültig gelöscht. ' +
  'Anonyme Nutzungsstatistiken (Token- und Kostenzahlen, ohne Inhalte) bleiben erhalten.';

/**
 * List conversations. Scoped to the signed-in user (so history follows the
 * account across sessions/devices); falls back to the anonymous session for
 * legacy/unauthenticated callers.
 */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (user) {
    // Adopt this browser's pre-login chats so they appear in account history.
    const sessionId = readSessionId(req);
    if (sessionId) await claimSessionConversations(sessionId, user.id);
    return NextResponse.json({ conversations: await listConversationsForUser(user.id) });
  }
  const sessionId = readSessionId(req);
  if (!sessionId) return NextResponse.json({ conversations: [] });
  return NextResponse.json({ conversations: await listConversations(sessionId) });
}

/** Erase every conversation owned by the caller (user, else session). */
export async function DELETE(req: NextRequest) {
  const user = await getUserFromRequest(req);
  const sessionId = readSessionId(req);
  if (user) {
    // Adopt this session's anonymous conversations before user-scoped erasure.
    if (sessionId) await claimSessionConversations(sessionId, user.id);
    const deleted = await deleteAllConversationsForUser(user.id);
    return NextResponse.json({ deleted, message: ERASE_MESSAGE });
  }
  if (!sessionId) {
    return NextResponse.json({ deleted: 0, message: 'Keine Sitzung — nichts zu löschen.' });
  }
  const deleted = await deleteAllConversations(sessionId);
  return NextResponse.json({ deleted, message: ERASE_MESSAGE });
}
