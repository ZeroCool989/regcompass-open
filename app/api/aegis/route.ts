import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { buildUserSoulBlock } from '@/lib/aegis/soul-store';
import { resolveServiceAuth } from '@/lib/aegis/service-auth';
import { runAegis, runAegisStreaming, UsageRecorder } from '@/lib/aegis';
import { deriveFirstName } from '@/lib/aegis/prompts/voice';
import { AegisError } from '@/lib/aegis/types';
import { intEnv } from '@/lib/aegis/env';
import { createHeartbeat } from '@/lib/aegis/heartbeat';
import { KB } from '@/lib/kb';

// Allow long, streamed report generations to run server-side. Must be ≥
// STREAM_DEADLINE_MS so the app emits its own clean timeout BEFORE the platform
// kills the function. Vercel Pro/Fluid supports 300s; lower plans cap below this.
export const maxDuration = 300;

const aegisLimiter = rateLimit({
  key: 'aegis',
  limit: 30,
  windowMs: 60 * 60 * 1000,
});

// Service (voice-gateway) path gets its OWN limit, keyed per voice session — a
// live voice conversation is far chattier than text chat, so 30/h would throttle
// a single ~10-minute demo. Default 120/h; override via AEGIS_SERVICE_RATE_LIMIT.
const SERVICE_RATE_LIMIT = Math.max(1, Number(process.env.AEGIS_SERVICE_RATE_LIMIT ?? '120'));
const serviceLimiter = rateLimit({
  key: 'aegis-service',
  limit: SERVICE_RATE_LIMIT,
  windowMs: 60 * 60 * 1000,
});

type AegisRouteSuccess = {
  response: string;
  citations: string[];
  meta: {
    mode: string;
    model: string;
    cost: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      usd: number;
    };
    latency: number;
    verification:
      | {
          ok: true;
          checks: Record<string, 'pass' | 'warn'>;
          warnings?: Array<{ check: string; reason: string }>;
        }
      | { ok: false; failed: string; reason: string };
    conversationId: string;
    iterations: number;
    toolCalls: Array<{ name: string; input: unknown; resultPreview: string }>;
    persisted: boolean;
    /**
     * Graceful degradation: `'iteration'`/`'cost'` (forced out at the ceiling)
     * or `'verify'` (report complete but citation verification could not finish
     * in the wall-clock budget — shown with a banner, not a verified success).
     */
    degraded?: 'iteration' | 'cost' | 'verify';
  };
};

type AegisRouteError = {
  error: string;
  message: string;
  conversationId?: string;
  issues?: unknown;
};

function wantsStreaming(req: NextRequest): boolean {
  const accept = req.headers.get('accept') ?? '';
  // Treat anything that explicitly asks for JSON as a JSON request. Otherwise
  // (including default / no Accept header) prefer SSE — the UI sends
  // `Accept: text/event-stream` explicitly.
  if (accept.includes('text/event-stream')) return true;
  if (accept.includes('application/json') && !accept.includes('text/event-stream')) {
    return false;
  }
  // No Accept hint: default to JSON for backwards compatibility (curl tests,
  // any caller written before the SSE branch existed).
  return false;
}

function encodeSse(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

// Hard ceiling for one SSE response. GAP_ANALYZE (25 iterations × 3 verify
// attempts) is the long pole; 270s stays under typical serverless function
// caps while still giving complex runs room.
// App-level stream deadline: AEGIS emits its own clean `timeout` error before
// the hosting platform kills the function. Must stay BELOW the platform's
// function limit (Vercel `maxDuration`). Env-overridable so long-report
// deployments (Fluid compute) can push it toward the platform max, and local
// dev can raise it freely. Default 290s uses the full maxDuration=300 window.
const STREAM_DEADLINE_MS = intEnv('AEGIS_STREAM_DEADLINE_MS', 290_000);

function streamingResponse(
  body: unknown,
  traceId: string,
  sessionId: string | null,
  userId: string | null,
  soulBlock: string | null,
  firstName: string | null,
): Response {
  const startedAt = Date.now();
  // The recorder owns the run's CostAccumulator. Flushing it from `finally`
  // and `cancel` (not only on the terminal `done` event) means a stream that
  // errors or is aborted mid-generation still records the tokens already
  // billed — the main source of the dashboard under-count.
  const recorder = new UsageRecorder(traceId, KB.version);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Set once a `done` or `error` event has gone out. The finally block
      // guarantees the client always receives SOME terminal event — without
      // one it would spin on "generating" forever.
      let terminalSent = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true; // client gone / controller closed — stop writing
        }
      };

      // Absolute deadline shared with the loop: the route enforces it as a hard
      // cut-off (Promise.race below); the loop reads it to gate expensive verify
      // recovery and degrade gracefully BEFORE this fires (lib/aegis/degrade.ts).
      const deadlineAt = Date.now() + STREAM_DEADLINE_MS;
      const gen = runAegisStreaming(body, recorder, {
        sessionId,
        userId,
        soulBlock,
        firstName,
        deadlineAt,
      });
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        deadlineTimer = setTimeout(() => resolve('timeout'), STREAM_DEADLINE_MS);
      });

      // Heartbeat: emit a lightweight `ping` every ~25 s so the client's idle
      // timer never fires during a long tool loop or long generation. It writes
      // bytes (which reset the client idle timer) but carries no answer/tool/
      // attachment content, so it never affects the rendered response or history.
      // `safeEnqueue` is a no-op once the stream is closed.
      const heartbeat = createHeartbeat(() => {
        if (!closed && !terminalSent) safeEnqueue(encodeSse('ping', {}));
      }, intEnv('AEGIS_HEARTBEAT_MS', 25_000));

      try {
        while (true) {
          // Race each pull against the overall deadline so a hung upstream
          // call can't hold the response open indefinitely.
          const r = await Promise.race([gen.next(), deadline]);
          if (r === 'timeout') {
            recorder.setMeta({ exitReason: 'timeout' });
            safeEnqueue(
              encodeSse('error', {
                code: 'timeout',
                message: 'Die Anfrage hat das Zeitlimit überschritten. Bitte erneut versuchen.',
              }),
            );
            terminalSent = true;
            // Runs the generator's finally blocks (meta capture); any
            // still-pending upstream call settles in the background.
            void gen.return(undefined).catch(() => {});
            break;
          }
          if (r.done) break;
          // Sectioned terminals (job_*) count as clean stream ends too — the
          // SINGLE_PASS pair ('done'/'error') is unchanged (F5).
          if (
            r.value.type === 'done' ||
            r.value.type === 'error' ||
            r.value.type === 'job_done' ||
            r.value.type === 'job_paused' ||
            r.value.type === 'job_failed'
          ) {
            terminalSent = true;
          }
          safeEnqueue(encodeSse(r.value.type, r.value));
        }
      } catch (err) {
        // Most errors arrive as `error` events from runAegisStreaming itself;
        // this catches anything that escapes. Detail stays in server logs.
        console.error('[aegis route] stream error:', err);
        safeEnqueue(
          encodeSse('error', {
            code: 'internal_error',
            message: 'Unerwarteter Fehler im Stream.',
          }),
        );
        terminalSent = true;
      } finally {
        heartbeat.stop();
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!terminalSent) {
          safeEnqueue(
            encodeSse('error', {
              code: 'internal_error',
              message: 'Der Stream wurde unerwartet beendet.',
            }),
          );
        }
        recorder.flush(Date.now() - startedAt);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        closed = true;
      }
    },
    cancel() {
      // Client disconnected mid-stream — still record what was generated.
      recorder.flush(Date.now() - startedAt);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Avoid buffering by reverse proxies (e.g. nginx). No-op in vercel.
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<AegisRouteSuccess | AegisRouteError> | Response> {
  const startedAt = Date.now();

  // Service (voice-gateway) auth. Header-only, so resolved before body parse and
  // before the limiter — it picks the limiter bucket. `none` is the unchanged
  // public/cookie path.
  const auth = resolveServiceAuth(req);

  // Rate limit: a valid service call is keyed per voice session against the
  // higher service limit; everything else (public, cookie, invalid-token) keeps
  // the 30/h IP bucket — so bad-token probing is still throttled.
  const limit =
    auth.kind === 'valid'
      ? await serviceLimiter.check(auth.sessionId)
      : await aegisLimiter.check(ipHash(req));
  if (!limit.ok) {
    return NextResponse.json<AegisRouteError>(
      {
        error: 'rate_limited',
        message:
          auth.kind === 'valid'
            ? `AEGIS-Service-Limit erreicht (${SERVICE_RATE_LIMIT} pro Stunde). Bitte später erneut versuchen.`
            : 'AEGIS-Limit erreicht (30 Anfragen pro Stunde). Bitte später erneut versuchen.',
      },
      {
        status: 429,
        headers: { 'Retry-After': '3600' },
      },
    );
  }

  // A present-but-invalid service token is rejected outright (no silent
  // downgrade). Emit the FAILED attempt (event only, never the token) so probing
  // of the service endpoint is observable.
  if (auth.kind === 'invalid') {
    console.error(
      JSON.stringify({
        event: 'aegis_service_auth_failed',
        level: 'warn',
        reason: auth.reason,
        ip: ipHash(req),
      }),
    );
    return NextResponse.json<AegisRouteError>(
      { error: 'unauthorized', message: 'Invalid service credentials.' },
      { status: 401 },
    );
  }

  // Browser callers (no service token) must be a signed-in, APPROVED user —
  // AEGIS spends Claude API tokens, so it's gated behind approval. The voice
  // gateway (auth.kind === 'valid') is authenticated by its service token and
  // is exempt. The resolved user id owns the conversation (history follows the
  // account); service calls stay session-scoped (userId null).
  let userId: string | null = null;
  let firstName: string | null = null;
  if (auth.kind === 'none') {
    const user = await getUserFromRequest(req);
    if (!user || !isApproved(user)) {
      return NextResponse.json<AegisRouteError>(
        {
          error: user ? 'not_approved' : 'unauthorized',
          message: user
            ? 'Ihr Konto wartet auf Freigabe durch einen Administrator.'
            : 'Bitte melden Sie sich an, um AEGIS zu nutzen.',
        },
        { status: user ? 403 : 401 },
      );
    }
    userId = user.id;
    firstName = deriveFirstName(user.username);
  }

  // Style-only personalization (soul.md). Loaded only for the browser path;
  // the voice-gateway service path stays impersonal. Null when the user has no
  // approved entries — then the run is byte-identical to the non-personalized
  // path. Fail-open: a soul lookup error must never block a chat turn.
  let soulBlock: string | null = null;
  if (userId) {
    try {
      soulBlock = await buildUserSoulBlock(userId);
    } catch {
      soulBlock = null;
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json<AegisRouteError>(
      { error: 'invalid_input', message: 'Der Anfrage-Inhalt muss gültiges JSON sein.' },
      { status: 400 },
    );
  }

  const traceId = randomUUID();
  // Session scope for memory + document tools. A valid service token supplies a
  // `voice:`-namespaced id (enforced in resolveServiceAuth); otherwise the
  // verified browser cookie (set by proxy.ts / the upload route), or null for an
  // anonymous public caller (stateless turn).
  const sessionId = auth.kind === 'valid' ? auth.sessionId : readSessionId(req);

  // SSE branch — UI default. Caller opts in via `Accept: text/event-stream`.
  // Streams tool-call status updates and token deltas of the final answer.
  if (wantsStreaming(req)) {
    return streamingResponse(body, traceId, sessionId, userId, soulBlock, firstName);
  }

  // The recorder is flushed in `finally`, so usage is logged whether runAegis
  // returns or throws (cost cap, verify exhaustion, upstream error).
  const recorder = new UsageRecorder(traceId, KB.version);
  try {
    const result = await runAegis(body, recorder, { sessionId, userId, soulBlock, firstName });
    const latency = Date.now() - startedAt;

    // Echo the validated `mode` if present in the request, otherwise omit.
    const requestedMode =
      typeof body === 'object' && body && 'mode' in body
        ? String((body as { mode: unknown }).mode)
        : 'unknown';

    return NextResponse.json<AegisRouteSuccess>({
      response: result.text,
      citations: result.citations,
      meta: {
        mode: requestedMode,
        model: result.modelUsed,
        cost: result.cost,
        latency,
        verification: result.verify.ok
          ? { ok: true, checks: result.verify.checks }
          : {
              ok: false,
              failed: result.verify.failed,
              reason: result.verify.reason,
            },
        conversationId: result.conversationId,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        persisted: result.persisted,
        degraded: result.degraded,
      },
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json<AegisRouteError>(
        {
          error: 'invalid_input',
          message: err.issues.some((i) => i.path.join('.') === 'message' && i.code === 'too_big')
            ? 'Die Eingabe ist zu lang. Bitte kürzen oder als Dokument hochladen; AEGIS komprimiert anschließend den Verlauf automatisch.'
            : 'Die Anfrage hat die Validierung nicht bestanden.',
          issues: err.issues,
        },
        { status: 400 },
      );
    }
    if (err instanceof AegisError) {
      return NextResponse.json<AegisRouteError>(
        {
          error: err.code,
          message: err.message,
          conversationId: err.conversationId,
        },
        { status: err.httpStatus },
      );
    }
    console.error('[aegis route] unhandled error:', err);
    return NextResponse.json<AegisRouteError>(
      {
        error: 'internal_error',
        message: 'Unerwarteter Fehler. Bitte erneut versuchen.',
      },
      { status: 500 },
    );
  } finally {
    // Fire-and-forget usage log. No-op when nothing was billed (e.g. a Zod
    // rejection before any Claude call). Failures are swallowed in logUsage.
    recorder.flush(Date.now() - startedAt);
  }
}
