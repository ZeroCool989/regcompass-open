import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readSessionId } from '@/lib/session';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { exportAssessment, EXPORT_FORMATS } from '@/lib/aegis/export';
import { ExportVerificationError } from '@/lib/aegis/export/verify';

export const maxDuration = 120;

/**
 * Direct export endpoint for the UI export menu ("Als Excel/Word/PDF
 * exportieren") — same engine as the `export_assessment` AEGIS tool, without a
 * model turn. Generation is deterministic; only conversation-findings
 * extraction can spend tokens, and that spend is not billed to a chat turn, so
 * the endpoint is rate-limited separately.
 *
 * Known limitation (documented): extraction spend on THIS route is not folded
 * into AegisUsageLog (no ToolContext.onUsage recorder here — the tool path has
 * one). Bounded by the 20/15min rate limit; wire a UsageRecorder if per-user
 * cost ceilings land on non-chat endpoints.
 */

const BodySchema = z.object({
  format: z.enum(EXPORT_FORMATS as [string, ...string[]]),
  conversationId: z.string().uuid().optional(),
  policyDocumentId: z.string().max(100).optional(),
  messageIds: z.array(z.string().max(100)).max(50).optional(),
  regulations: z.array(z.string().max(60)).max(20).optional(),
  title: z.string().max(140).optional(),
});

const limiter = rateLimit({ key: 'aegis-export', limit: 20, windowMs: 15 * 60 * 1000 });

export async function POST(req: NextRequest) {
  const ip = await ipHash(req);
  const rl = await limiter.check(ip);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Exporte — bitte kurz warten.' },
      { status: 429, headers: { 'Retry-After': '900' } },
    );
  }

  const user = await getUserFromRequest(req);
  if (!isApproved(user)) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  const sessionId = readSessionId(req);
  if (!sessionId) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Keine aktive Sitzung — Seite neu laden und erneut versuchen.' },
      { status: 400 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Ungültige Export-Anfrage.' },
      { status: 400 },
    );
  }

  try {
    const result = await exportAssessment(
      {
        format: body.format as (typeof EXPORT_FORMATS)[number],
        policyDocumentId: body.policyDocumentId,
        messageIds: body.messageIds,
        regulations: body.regulations,
        title: body.title,
      },
      {
        sessionId,
        userId: user?.id ?? null,
        conversationId: body.conversationId ?? null,
      },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExportVerificationError) {
      return NextResponse.json(
        { error: 'export_failed', message: err.message },
        { status: 500 },
      );
    }
    const message =
      err instanceof Error && err.message
        ? err.message
        : 'Export fehlgeschlagen — bitte erneut versuchen.';
    // Domain errors (no findings, no source, ownership) are user-safe German
    // messages from the engine; everything else stays generic.
    return NextResponse.json({ error: 'invalid_input', message }, { status: 400 });
  }
}
