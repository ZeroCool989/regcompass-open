import { NextResponse, type NextRequest } from 'next/server';
import { readSessionId } from '@/lib/session';
import { getUserFromRequest } from '@/lib/auth';
import {
  claimSessionConversations,
  deleteConversation,
  deleteConversationForUser,
  getTranscript,
  getTranscriptForUser,
} from '@/lib/aegis/memory';

// A foreign, expired, or nonexistent conversation is indistinguishable: 404
// with the same body (mirrors the AegisDocument download route).
function notFound() {
  return NextResponse.json(
    { error: 'not_found', message: 'Unterhaltung nicht gefunden oder abgelaufen.' },
    { status: 404 },
  );
}

/** Full transcript, scoped to the signed-in user (else the anonymous session). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getUserFromRequest(req);
  if (user) {
    // Claim this browser's anonymous chats first, so a conversation started
    // before login is readable under the account.
    const sessionId = readSessionId(req);
    if (sessionId) await claimSessionConversations(sessionId, user.id);
  }
  const transcript = user
    ? await getTranscriptForUser(id, user.id)
    : await getTranscript(id, readSessionId(req));
  if (!transcript) return notFound();
  return NextResponse.json(transcript);
}

/** Hard-delete one conversation (cascades to its messages). */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getUserFromRequest(req);
  const deleted = user
    ? await deleteConversationForUser(id, user.id)
    : await deleteConversation(id, readSessionId(req));
  if (!deleted) return notFound();
  return NextResponse.json({
    deleted: true,
    message:
      'Unterhaltung und Nachrichten wurden endgültig gelöscht. ' +
      'Anonyme Nutzungsstatistiken (Token- und Kostenzahlen, ohne Inhalte) bleiben erhalten.',
  });
}
