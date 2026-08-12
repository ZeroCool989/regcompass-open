import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { CostAccumulator } from '@/lib/aegis/context/cost';
import { intEnv } from '@/lib/aegis/env';
import { createHeartbeat } from '@/lib/aegis/heartbeat';
import { getModeSpec } from '@/lib/aegis/modes';
import { UsageRecorder } from '@/lib/aegis';
import { KB } from '@/lib/kb';
import { AegisError, AegisModeInput } from '@/lib/aegis/types';
import { resolveRuntimeCredential, runtimeProviderForJob } from '@/lib/aegis/runtime-selection';
import {
  consumeResume,
  firstUserMessage,
  loadJobForOwner,
  resetStaleWriting,
  transitionJob,
} from '@/lib/aegis/sectioned/job-store';
import { executeJobSections } from '@/lib/aegis/sectioned/executor';
import { persistAssembledReport } from '@/lib/aegis/sectioned/assemble';
import type { JobStatus } from '@/lib/aegis/sectioned/statechart';

/**
 * Resume endpoint for sectioned jobs (epic F2/F4). `GET` opens an SSE stream
 * that first replays the job's current state (jobId is the cursor — no native
 * Last-Event-ID; the client uses a fetch reader) and then continues execution
 * from the persisted cursor.
 *
 * Order of gates (F4): ownership BEFORE any budget consumption — a foreign or
 * unknown job answers 404 without touching limiter buckets or resumeCount (no
 * existence oracle). Then the per-session resume bucket, then the atomic
 * resumeCount increment (hard cap AEGIS_JOB_MAX_RESUMES → job fails closed).
 * Transport errors stay HTTP-JSON before the stream begins (F5).
 */

export const maxDuration = 300;

const RESUME_DEADLINE_MS = intEnv('AEGIS_STREAM_DEADLINE_MS', 290_000);

// F4: resumes get their OWN per-session bucket — never the shared 30/h IP
// bucket, so a long report's reconnects don't starve normal chat turns.
const resumeLimiter = rateLimit({
  key: 'aegis-resume',
  limit: intEnv('AEGIS_RESUME_RATE_LIMIT', 30),
  windowMs: 60 * 60 * 1000,
});

function encodeSse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const TERMINAL_EVENTS = new Set(['job_done', 'job_paused', 'job_failed', 'error']);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: jobId } = await params;
  const startedAt = Date.now();

  // Browser auth mirror of POST /api/aegis: signed-in AND approved.
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json(
      {
        error: user ? 'not_approved' : 'unauthorized',
        message: user
          ? 'Ihr Konto wartet auf Freigabe durch einen Administrator.'
          : 'Bitte melden Sie sich an, um AEGIS zu nutzen.',
      },
      { status: user ? 403 : 401 },
    );
  }
  const sessionId = readSessionId(req);

  // ── F4 gate 1: ownership BEFORE budget. Unknown/foreign/expired → 404. ──
  const loaded = await loadJobForOwner(jobId, { sessionId, userId: user.id });
  if (!loaded) {
    return NextResponse.json(
      { error: 'not_found', message: 'Job nicht gefunden.' },
      { status: 404 },
    );
  }

  const jobStatus = loaded.job.status as JobStatus;
  if (jobStatus === 'failed') {
    return NextResponse.json(
      { error: 'job_failed', message: 'Dieser Report wurde abgebrochen.' },
      { status: 410 },
    );
  }

  // A finished job replays its state once — cheap, idempotent, no budget.
  if (jobStatus === 'done') {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encodeSse('job_state', {
            type: 'job_state',
            jobId,
            cursor: loaded.job.cursor,
            sections: loaded.sections.map((s) => ({
              index: s.index,
              title: s.title,
              status: s.status,
              contentMd: s.contentMd ?? undefined,
            })),
          }),
        );
        controller.enqueue(
          encodeSse('job_done', { type: 'job_done', jobId, cursor: loaded.job.cursor }),
        );
        controller.close();
      },
    });
    return sseResponse(stream);
  }

  // ── F4 gate 2: per-session resume bucket. ──
  const limit = await resumeLimiter.check(sessionId ?? ipHash(req));
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'Resume-Limit erreicht. Bitte später erneut versuchen.',
      },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // ── F4 gate 3: atomic resume budget — cap exhausted → job fails closed. ──
  const budget = await consumeResume(jobId, jobStatus);
  if (!budget.ok) {
    console.error(
      JSON.stringify({
        event: 'aegis_job_resume_cap',
        level: 'warn',
        jobId,
        userId: user.id,
      }),
    );
    return NextResponse.json(
      {
        error: 'resume_cap_exceeded',
        message: 'Dieser Report wurde zu oft fortgesetzt und wurde beendet.',
      },
      { status: 410 },
    );
  }

  // Crash recovery: an invocation killed mid-section leaves status 'running'
  // and a stale 'writing' section. Park it, reset stale sections (their partial
  // output was never persisted — regeneration cannot duplicate work), resume.
  if (jobStatus === 'running') {
    await transitionJob(jobId, 'running', 'paused');
  }
  await resetStaleWriting(jobId);
  await transitionJob(jobId, 'paused', 'running');

  // Re-load AFTER the reset so cursor/sections reflect the resumable state.
  const fresh = await loadJobForOwner(jobId, { sessionId, userId: user.id });
  if (!fresh) {
    return NextResponse.json(
      { error: 'not_found', message: 'Job nicht gefunden.' },
      { status: 404 },
    );
  }

  const conversationLanguage = fresh.conversation.language;
  const recorder = new UsageRecorder(crypto.randomUUID(), KB.version);
  const costAcc: CostAccumulator = recorder.cost;
  const deadlineAt = Date.now() + RESUME_DEADLINE_MS;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let terminalSent = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      const heartbeat = createHeartbeat(() => {
        if (!closed && !terminalSent) safeEnqueue(encodeSse('ping', {}));
      }, intEnv('AEGIS_HEARTBEAT_MS', 25_000));

      try {
        // State snapshot first — the reconnecting client rebuilds finished
        // sections from this, then appends live events.
        safeEnqueue(
          encodeSse('job_state', {
            type: 'job_state',
            jobId,
            cursor: fresh.job.cursor,
            sections: fresh.sections.map((s) => ({
              index: s.index,
              title: s.title,
              status: s.status,
              contentMd: s.contentMd ?? undefined,
            })),
          }),
        );

        // Legacy rows may still carry the retired CONTROL_ADVISE mode (or, in
        // degenerate cases, none at all) — coerce instead of crashing the resume.
        const parsedMode = AegisModeInput.safeParse(fresh.conversation.mode);
        const mode = parsedMode.success ? parsedMode.data : 'CONVERSATIONAL';
        // Restore the FROZEN provider from the job (never re-read User.aegisProvider).
        // Fails closed on a gated (gemini/codex) or missing legacy provider — the
        // section loop, repair, digest and glue then all dispatch on this brain.
        const jobProvider = runtimeProviderForJob(fresh.job.provider, conversationLanguage);
        // Resolve the credential for THAT provider + this owner, with the same
        // BYOK → system-key → typed-failure precedence as the initial run — so a
        // job started on the user's BYOK key resumes on it, not the system account.
        const jobCredential = await resolveRuntimeCredential(jobProvider, user.id, conversationLanguage);
        const originalAsk = await firstUserMessage(fresh.job.conversationId);
        const executor = executeJobSections(
          fresh,
          {
            baseSpec: getModeSpec(mode, conversationLanguage),
            language: conversationLanguage,
            userMessage: originalAsk ?? resumeUserMessage(fresh),
            deadlineAt,
            cost: costAcc,
            toolContext: {
              sessionId,
              userId: user.id,
              conversationId: fresh.job.conversationId,
              provider: jobProvider,
              // BYOK key when the user has one; null → the provider's system env
              // key. Same precedence as the initial run; never logged.
              anthropicApiKey: jobCredential.source === 'user' ? jobCredential.apiKey : null,
              onUsage: (model, usage) => costAcc.add(model, usage),
            },
          },
        );
        let r = await executor.next();
        while (!r.done) {
          if (TERMINAL_EVENTS.has(r.value.type)) terminalSent = true;
          safeEnqueue(encodeSse(r.value.type, r.value));
          r = await executor.next();
        }
        if (r.value.status === 'done') {
          await persistAssembledReport({
            jobId,
            conversationId: fresh.job.conversationId,
            mode,
            provider: jobProvider,
          });
        }
        recorder.setMeta({
          conversationId: fresh.job.conversationId,
          exitReason: `sectioned_${r.value.status}`,
        });
      } catch (err) {
        console.error('[aegis job resume] stream error:', err);
        // A typed AegisError (e.g. the fail-closed provider restore, or a gated
        // Gemini/Codex job) carries a user-safe message + code; surface those.
        const isTyped = err instanceof AegisError;
        safeEnqueue(
          encodeSse('job_failed', {
            type: 'job_failed',
            jobId,
            code: isTyped ? err.code : 'internal_error',
            message: isTyped
              ? err.message
              : 'Der Report konnte nicht fortgesetzt werden. Bereits fertige Abschnitte sind gespeichert.',
          }),
        );
        terminalSent = true;
      } finally {
        heartbeat.stop();
        if (!terminalSent) {
          safeEnqueue(
            encodeSse('job_paused', { type: 'job_paused', jobId, cursor: -1 }),
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
      recorder.flush(Date.now() - startedAt);
    },
  });
  return sseResponse(stream);
}

/** Reconstruct the section-writing prompt context from the persisted plan. */
function resumeUserMessage(loaded: NonNullable<Awaited<ReturnType<typeof loadJobForOwner>>>): string {
  // The original user message is the first user turn of the conversation; the
  // executor's section context block carries the plan/scope. Falling back to a
  // plan-derived instruction keeps resumes self-contained even if the turn
  // cannot be re-read here (memory access is the wiring's concern, not ours).
  const titles = loaded.sections.map((s) => s.title).join('; ');
  return `Setze den geplanten Report fort. Abschnitte laut Plan: ${titles}.`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
