import { callHaiku } from '../client';
import { CostAccumulator, type ClaudeUsage } from '../context/cost';
import type { ModeSpec } from '../modes';
import { AegisError, MODEL_IDS } from '../types';
import { jobProviderForRuntime } from '../runtime-selection';
import type { LoopState } from '../loop';
import type { ToolAuditEntry } from '../types';
import { classifyTriage, type TriageResult } from './triage';
import { generatePlan, PlanValidationError, type AegisPlan } from './plan';
import { createJob, transitionJob, type JobDb, type JobWithSections } from './job-store';
import { executeJobSections, type ExecutorOutcome } from './executor';
import { persistAssembledReport } from './assemble';
import type { SectionedStreamEvent } from './events';

/**
 * Sectioned wiring (Station 2). Feature-flagged OFF by default: until PR 3
 * ships the client reducer/progress UI, live behaviour must stay byte-identical
 * to SINGLE_PASS (F5). Set AEGIS_SECTIONED_ENABLED=1 in dev to exercise the
 * pipeline end-to-end.
 */
export function sectionedEnabled(): boolean {
  return process.env.AEGIS_SECTIONED_ENABLED === '1';
}

/**
 * F7: ONE combined Haiku triage call (mode + complexity + deliverableKind).
 * Voice turns skip triage entirely and are always SINGLE_PASS.
 */
export async function triageRequest(
  message: string,
  provider: 'anthropic' | 'gemini',
  onUsage: (usage: ClaudeUsage) => void,
): Promise<TriageResult> {
  // Triage dispatches on the request's selected brain — same as the main loop.
  return classifyTriage(message, (p) => callHaiku({ ...p, provider }), onUsage);
}

export type SectionedStartArgs = {
  conversationId: string;
  mode: string;
  baseSpec: ModeSpec;
  language: 'de' | 'en';
  userMessage: string;
  deadlineAt: number;
  cost: CostAccumulator;
  toolContext: LoopState['toolContext'];
  toolAudit?: ToolAuditEntry[];
  client?: JobDb;
  planFn?: typeof generatePlan;
};

export type SectionedStartOutcome =
  | { kind: 'fallback_single_pass'; reason: string }
  | { kind: 'ran'; outcome: ExecutorOutcome; jobId: string };

/**
 * Plan → job → executor for a NEW sectioned request. On PlanValidationError
 * (or any plan-stage failure) the caller silently continues single-pass — the
 * iron rule: no internal failure surfaces to the user. The generator yields
 * nothing before the plan succeeds, so a fallback leaves the stream untouched.
 */
export async function* startSectionedJob(
  args: SectionedStartArgs,
): AsyncGenerator<SectionedStreamEvent, SectionedStartOutcome, void> {
  const planFn = args.planFn ?? generatePlan;

  // The request's ALREADY-FROZEN provider — resolved BEFORE the plan pass so no
  // Sectioned model call (plan included) can ever run without it. Never
  // re-resolved, never defaulted to Anthropic; resume reads it from the job.
  const frozen = args.toolContext?.provider;
  if (!frozen) {
    throw new AegisError('internal_error', 'Sectioned job started without a frozen provider selection.');
  }

  let plan: AegisPlan;
  try {
    const result = await planFn(args.userMessage, args.language, frozen);
    args.cost.add(MODEL_IDS.sonnet, result.usage);
    plan = result.plan;
  } catch (err) {
    const reason = err instanceof PlanValidationError ? 'plan_validation' : 'plan_failed';
    console.error(
      JSON.stringify({
        event: 'aegis_sectioned_fallback_single_pass',
        level: 'warn',
        reason,
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      }),
    );
    return { kind: 'fallback_single_pass', reason };
  }

  // Persist the frozen provider on the job — resume reads this, not User.aegisProvider.
  const job = await createJob(args.conversationId, plan, jobProviderForRuntime(frozen), args.client);
  await transitionJob(job.id, 'planning', 'running', args.client);
  yield {
    type: 'job_created',
    jobId: job.id,
    sections: plan.sections.map((s, index) => ({
      index,
      title: s.title,
      grounded: s.grounded,
    })),
  };

  const loaded: JobWithSections = {
    job: { ...job, status: 'running' },
    sections: [],
    conversation: { mode: args.mode, language: args.language },
  };
  const outcome = yield* executeJobSections(
    loaded,
    {
      baseSpec: args.baseSpec,
      language: args.language,
      userMessage: args.userMessage,
      deadlineAt: args.deadlineAt,
      cost: args.cost,
      toolContext: args.toolContext,
      toolAudit: args.toolAudit,
    },
    { client: args.client },
  );

  if (outcome.status === 'done') {
    await persistAssembledReport({
      jobId: job.id,
      conversationId: args.conversationId,
      mode: args.mode,
      provider: args.toolContext?.provider,
      client: args.client,
    });
  }
  return { kind: 'ran', outcome, jobId: job.id };
}
