import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { listConversationsForUser, getTranscriptForUser } from '@/lib/aegis/memory';
import { generateSoulProposals } from '@/lib/aegis/soul';
import { createProposals, listPendingProposals } from '@/lib/aegis/soul-store';

const limiter = rateLimit({ key: 'soul-observe', limit: 20, windowMs: 60 * 60 * 1000 });

// How many recent conversations to inspect, and the char cap on the combined
// transcript fed to the proposer.
const RECENT_CONVERSATIONS = 3;
const MAX_TRANSCRIPT_CHARS = 30_000;

/**
 * User-initiated observation: the AI inspects the user's recent conversations
 * and PROPOSES style preferences (PENDING). It can never write a SoulEntry —
 * only the accept route does that, after the user decides. Proposals are
 * firewalled at generation, so forbidden content never even appears as a
 * suggestion.
 */
export async function POST(req: NextRequest) {
  const limit = await limiter.check(ipHash(req));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Anfragen. Bitte später erneut.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  const conversations = (await listConversationsForUser(user.id)).slice(0, RECENT_CONVERSATIONS);
  let transcript = '';
  for (const c of conversations) {
    const t = await getTranscriptForUser(c.id, user.id);
    if (!t) continue;
    transcript +=
      t.messages
        .filter((m) => m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => `${m.role === 'user' ? 'NUTZER' : 'AEGIS'}: ${m.content}`)
        .join('\n') + '\n\n';
    if (transcript.length >= MAX_TRANSCRIPT_CHARS) break;
  }
  if (transcript.trim().length === 0) {
    return NextResponse.json(
      { error: 'no_history', message: 'Noch keine Gespräche, aus denen Präferenzen ableitbar sind.' },
      { status: 400 },
    );
  }

  let created: number;
  try {
    const drafts = await generateSoulProposals(transcript.slice(0, MAX_TRANSCRIPT_CHARS));
    created = await createProposals(user.id, drafts, {
      conversations: conversations.map((c) => c.id),
    });
  } catch {
    return NextResponse.json(
      { error: 'observe_failed', message: 'Vorschläge konnten nicht erstellt werden.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ created, proposals: await listPendingProposals(user.id) });
}
