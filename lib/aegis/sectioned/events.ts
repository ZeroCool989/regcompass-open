/**
 * SECTIONED-only stream events (epic F5). The SINGLE_PASS event set is a
 * byte-identical regression contract and lives in `lib/aegis/loop.ts`
 * (`LoopStreamEvent`) — this set applies ONLY to jobs that triage routed to
 * the sectioned pipeline, and is therefore free to evolve with PR 3 (client
 * store/reducer + progress UI), which owns the client-facing contract.
 *
 * Transport errors (401/403/404/429) stay HTTP-JSON before stream begin (F5);
 * once streaming, the iron rule applies: no internal event (retry, verify
 * failure, pause, model choice, timeout) surfaces as a user-facing error.
 */

export type SectionedStreamEvent =
  | {
      type: 'job_created';
      jobId: string;
      sections: Array<{ index: number; title: string; grounded: boolean }>;
    }
  /** Resume snapshot: full section state incl. finished content (jobId is the cursor — F2). */
  | {
      type: 'job_state';
      jobId: string;
      cursor: number;
      sections: Array<{
        index: number;
        title: string;
        status: string;
        contentMd?: string;
      }>;
    }
  | { type: 'section_start'; index: number; title: string }
  | { type: 'section_token'; index: number; text: string }
  | {
      type: 'section_done';
      index: number;
      status: 'done' | 'degraded';
      firstPassOk: boolean;
    }
  /** Clean pause (time floor / disconnect). The client reconnects via GET /api/aegis/jobs/[id]/stream. */
  | { type: 'job_paused'; jobId: string; cursor: number }
  | { type: 'job_done'; jobId: string; cursor: number }
  | { type: 'job_failed'; jobId: string; code: string; message: string };
