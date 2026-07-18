import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { readSessionId } from '@/lib/session';
import {
  claimSessionConversations,
  getTranscript,
  getTranscriptForUser,
  storeDigest,
} from '@/lib/aegis/memory';
import {
  DigestInputTooLargeError,
  generateDigest,
  type DigestMessage,
} from '@/lib/aegis/digest';

const limiter = rateLimit({ key: 'aegis-compact', limit: 20, windowMs: 60 * 60 * 1000 });

// Below this there's nothing worth compacting.
const MIN_MESSAGES = 4;

/**
 * Context compaction (Phase 2): summarize this conversation's history into a
 * structured digest and store it. Future turns replay the digest + later turns
 * instead of the full transcript. The transcript itself is left intact.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const limit = await limiter.check(ipHash(req));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Verdichtungen. Bitte später erneut.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // AEGIS spends Claude tokens here too — gate behind an approved account.
  const user = await getUserFromRequest(req);
  if (!isApproved(user)) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  const sessionId = readSessionId(req);
  if (user && sessionId) await claimSessionConversations(sessionId, user.id);

  const transcript = user
    ? await getTranscriptForUser(id, user.id)
    : await getTranscript(id, sessionId);
  if (!transcript) {
    return NextResponse.json(
      { error: 'not_found', message: 'Unterhaltung nicht gefunden oder abgelaufen.' },
      { status: 404 },
    );
  }

  // Only complete turns feed the digest; failed runs stay out of the prompt.
  const turns: DigestMessage[] = transcript.messages
    .filter((m) => m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, seq: m.seq }));

  if (turns.length < MIN_MESSAGES) {
    return NextResponse.json(
      { error: 'too_short', message: 'Zu wenig Verlauf zum Verdichten.' },
      { status: 400 },
    );
  }

  const throughSeq = Math.max(...turns.map((t) => t.seq));

  let digest;
  try {
    digest = await generateDigest(turns);
  } catch (err) {
    if (err instanceof DigestInputTooLargeError) {
      return NextResponse.json(
        {
          error: 'too_large',
          message:
            'Der Verlauf ist zu lang, um ihn in einem Schritt zu verdichten. ' +
            'Bitte leeren Sie den Chat oder starten Sie eine neue Unterhaltung.',
        },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { error: 'compaction_failed', message: 'Verdichtung fehlgeschlagen. Bitte erneut versuchen.' },
      { status: 502 },
    );
  }

  const ok = await storeDigest({
    id,
    sessionId,
    userId: user?.id ?? null,
    digest,
    throughSeq,
  });
  if (!ok) {
    return NextResponse.json(
      { error: 'not_found', message: 'Unterhaltung nicht gefunden.' },
      { status: 404 },
    );
  }

  return NextResponse.json({
    compacted: true,
    throughSeq,
    summary: {
      decisions: digest.decisions.length,
      openTasks: digest.openTasks.length,
      conclusions: digest.conclusions.length,
    },
    message:
      'Verlauf verdichtet — ältere Nachrichten werden ab der nächsten Antwort ' +
      'zusammengefasst an AEGIS übergeben. Der vollständige Verlauf bleibt sichtbar.',
  });
}
