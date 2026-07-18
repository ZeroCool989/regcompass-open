import type Anthropic from '@anthropic-ai/sdk';
import { callClaude, callHaiku, reportModelDrift, streamClaude } from './client';
import { compressContext } from './context/compress';
import { MemoryConfig } from './memory-config';
import { CostAccumulator } from './context/cost';
import {
  applyGuardrails,
  type PreGuardState,
} from './guardrails';
import type { ModeSpec } from './modes';
import { intEnv } from './env';
import { createToolRegistry } from './tools';
import {
  AegisError,
  DEFAULT_GUARDRAILS,
  MODEL_IDS,
  type AegisResponse,
  type ModelId,
  type ToolAuditEntry,
  type ToolContext,
  type ToolName,
  type VerifyResult,
} from './types';
import { isSoftCheck, verifyResponse, warnedResult } from './verify';
import {
  buildCitationRepairMessages,
  buildRegulationRepairMessages,
  isCitationFamily,
} from './citation-repair';
import {
  CONTINUATION_TIME_FLOOR_MS,
  REPAIR_RESERVE_MS,
  RETRY_RESERVE_MS,
  budgetedMaxTokens,
  prependDegradationBanner,
  timeLeftMs,
} from './degrade';

// ───────────────────────── Loop state ─────────────────────────

export type LoopState = {
  messages: Anthropic.MessageParam[];
  iteration: number;
  cost: CostAccumulator;
  toolCalls: AegisResponse['toolCalls'];
  toolsCalled: number;
  /** Union of every KB requirement ID returned by tool calls this turn. */
  allowedIds: Set<string>;
  /** Distinct served models (`response.model`) seen across this run — drift visibility. */
  servedModels: Set<string>;
  /** Parseable tokens for each guard action that fired (e.g. `compress`, `kill:cost_limit`). */
  guardrailsTriggered: string[];
  /** Per-request tool context (session scope for document tools). */
  toolContext?: ToolContext;
  /**
   * Full-fidelity tool log for the conversation audit sidecar. `toolCalls`
   * above truncates results to a 200-char preview for the client response;
   * tool results otherwise only exist inside `messages`, which verify-retries
   * rebuild — so the audit is captured separately at execution time.
   */
  toolAudit?: ToolAuditEntry[];
  /**
   * Set by 3.1 graceful degradation when the turn was forced to answer without
   * more tools — `'iteration'` (near the iteration ceiling) or `'cost'` (within
   * ~20% of the cost cap). Surfaced by the orchestrator as a distinct
   * `exitReason` (`forced_answer` / `forced_answer_cost`).
   */
  forcedAnswer?: 'iteration' | 'cost';
  /**
   * Absolute wall-clock instant (ms epoch) by which the run must finalise —
   * the streaming route's hard deadline. Used by the outer loop to gate
   * expensive verify recovery (repair / full retry) against the remaining time.
   * Undefined on the non-streaming JSON path and in tests → time gates are
   * no-ops (treated as infinite budget). See lib/aegis/degrade.ts.
   */
  deadlineAt?: number;
  /** Injectable clock for the time gates (defaults to `Date.now`); set in tests. */
  now?: () => number;
  /**
   * Set when the turn was finalised via time-pressure degradation (A3): the
   * report is complete but citation verification could not finish in time, so
   * it is returned with a banner. Surfaced as `degraded: 'verify'`.
   */
  verifyDegraded?: boolean;
};

const KB_ID_PATTERN = /R-[A-Z0-9]+-[A-Z0-9-]+/g;

// 3.3 — sent once when a turn stops on `max_tokens`, to let the model finish a
// truncated answer instead of failing verify on the cut-off text.
const CONTINUE_NUDGE =
  'Your previous message was cut off because it hit the length limit. Continue ' +
  'EXACTLY where you left off — do NOT repeat or re-introduce anything you already ' +
  'wrote. Preserve the same markdown structure, tables, numbering and headings, ' +
  'citations ([R-...]) and regulatory references. Just keep writing the next part.';

// Up to this many automatic continuations after a `max_tokens` stop, so long
// reports complete in one seamless turn without the user typing "continue".
// Env-overridable (AEGIS_MAX_CONTINUATIONS).
const MAX_CONTINUATIONS = intEnv('AEGIS_MAX_CONTINUATIONS', 3);

// Appended once continuations are exhausted — an explicit, visible close rather
// than a silent truncation.
const CONTINUATION_EXHAUSTED_NOTE =
  '\n\n> ⚠️ Hinweis: Der Bericht wurde nach der maximalen Anzahl automatischer ' +
  'Fortsetzungen aus Längengründen hier beendet. Fordere gezielt den nächsten ' +
  'Abschnitt an, um fortzufahren.';

// 3.1 — sent on the single forced, tool-free final call when the turn is out of
// iteration/cost budget. The model answers with whatever evidence it already
// retrieved instead of the run being hard-killed (discarding all its spend).
const FORCE_ANSWER_NUDGE =
  'You are out of research budget for this turn. Answer the question NOW using ' +
  'only the evidence you have already retrieved. Do not call any more tools. ' +
  'Cite the [R-...] IDs you already have; if some detail is missing, say so ' +
  'explicitly rather than guessing.';

// Fraction of the cost cap at which 3.1 forces a final answer (within ~20%).
const COST_DEGRADE_FRACTION = 0.8;

/**
 * Append the force-answer nudge as a trailing `text` block. When the last
 * message is already a `user` turn (tool_results / verify feedback) the nudge
 * is folded INTO it, so we never emit two consecutive user messages. Returns a
 * new array — `state.messages` is not mutated.
 */
function withForceAnswerNudge(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const nudge: Anthropic.TextBlockParam = { type: 'text', text: FORCE_ANSWER_NUDGE };
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const content: Anthropic.ContentBlockParam[] =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }, nudge]
        : [...last.content, nudge];
    return [...messages.slice(0, -1), { role: 'user', content }];
  }
  return [...messages, { role: 'user', content: FORCE_ANSWER_NUDGE }];
}

function extractKbIds(toolResultJson: string): string[] {
  return Array.from(new Set(toolResultJson.match(KB_ID_PATTERN) ?? []));
}

/**
 * Project the assistant's response content (richer `ContentBlock` types) onto
 * the leaner `ContentBlockParam` shape we're allowed to send back. Drops
 * server-side metadata (citations, signatures) that the API would otherwise
 * reject on re-send.
 */
function projectAssistantContent(
  blocks: Anthropic.ContentBlock[],
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input,
      });
    }
    // thinking / server_tool_use / etc. — intentionally dropped.
  }
  return out;
}

/**
 * Text-only projection for the `max_tokens` CONTINUATION seed.
 *
 * A turn cut off by `max_tokens` may end mid-`tool_use`. We must NOT re-send
 * that partial tool_use as the assistant turn: the continuation appends a plain
 * TEXT nudge (not a tool_result), and Anthropic hard-rejects (400) any
 * `tool_use` that isn't immediately followed by its `tool_result`. The
 * continuation only wants the model to finish its prose answer, so we keep just
 * the non-empty text blocks and drop everything else. Returns `[]` when there is
 * no text yet — the caller then skips the continuation rather than push an
 * empty (also-400) assistant message.
 */
function projectAssistantText(
  blocks: Anthropic.ContentBlock[],
): Anthropic.TextBlockParam[] {
  const out: Anthropic.TextBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text.length > 0) out.push({ type: 'text', text: b.text });
  }
  return out;
}

function joinTextBlocks(blocks: Anthropic.ContentBlock[]): string {
  return blocks
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n');
}

// ───────────────────────── Verify-retry trimming ─────────────────────────

/**
 * Pull the evidence for a retry out of the accreted history: the text of every
 * `tool_result` block, grouped per message ("batch"). Evidence = batches whose
 * content mentions an id in `allowedIds` (the KB entries backing legitimate
 * citations). Floor: if nothing is allowedId-backed (e.g. a language/non_empty
 * failure, or the answer cited nothing), fall back to the most recent batch so
 * the retry keeps *some* retrieval context. Returned as plain text.
 */
function selectEvidence(
  messages: Anthropic.MessageParam[],
  allowedIds: Set<string>,
): string {
  const batches: string[][] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    const batch: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        batch.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
      }
    }
    if (batch.length) batches.push(batch);
  }
  const ids = [...allowedIds];
  const backed = batches.flat().filter((r) => ids.some((id) => r.includes(id)));
  const chosen = backed.length ? backed : batches.length ? batches[batches.length - 1] : [];
  return chosen.join('\n---\n');
}

/**
 * Build the trimmed context for a verify retry. Re-runs the correction against
 * a lean, canonical view instead of the full accreted tool history:
 *   - `seed`: the original conversational turns (history + question), captured
 *     ONCE before any tool scaffolding — so retries don't accumulate.
 *   - the prior failed answer as an `assistant` turn (the model edits, not
 *     regenerates).
 *   - the evidence (KB entries backing `allowedIds`) as PLAIN TEXT folded into
 *     the feedback message — so no `tool_result` block is left orphaned (the API
 *     rejects a `tool_result` without a matching preceding `tool_use`).
 *   - the verify feedback.
 *
 * `allowedIds` is a separate Set on `state` and is NOT touched here — only
 * `state.messages` is rebuilt, so the citation trust anchor is preserved.
 */
export function trimForRetry(
  seed: Anthropic.MessageParam[],
  current: Anthropic.MessageParam[],
  allowedIds: Set<string>,
  failedText: string,
  feedbackContent: string,
): Anthropic.MessageParam[] {
  const evidence = selectEvidence(current, allowedIds);
  const evidenceBlock = evidence
    ? `Evidence already retrieved (cite these KB entries by their [R-...] IDs):\n${evidence}\n\n`
    : '';
  return [
    ...seed,
    { role: 'assistant', content: failedText || '(no answer was produced)' },
    { role: 'user', content: `${evidenceBlock}${feedbackContent}` },
  ];
}

/**
 * Citation-repair fast-path: a single TOOL-FREE model call that only fixes the
 * [R-...] citations in the failed draft (using IDs already retrieved this turn),
 * instead of re-running the full inner loop. Much cheaper/faster than a full
 * regeneration → removes the verify-retry timeout amplification. The repaired
 * text is re-verified by the caller (verify is unchanged). Returns the corrected
 * answer text. `tool_choice: 'none'` keeps the cached tool prefix stable while
 * forbidding tool calls.
 */
async function repairCitations(
  spec: ModeSpec,
  model: ModelId,
  seed: Anthropic.MessageParam[],
  failedText: string,
  state: LoopState,
  feedback: string,
): Promise<string> {
  const messages = buildCitationRepairMessages(seed, failedText, state.allowedIds, feedback);
  return runToolFreeRepair(spec, model, messages, state);
}

/**
 * Regulation-name repair fast-path: the same single tool-free edit call, but for
 * `no_hallucinated_regulations` failures — the model removes or descriptively
 * reformulates regulation/standard names that are not in the KB whitelist
 * (e.g. ISO 27001) instead of the outer loop re-running the full inner loop.
 * The repaired text is re-verified by the caller; the hallucination check
 * itself is unchanged and stays hard (no degrade banner for this family).
 */
async function repairRegulationNames(
  spec: ModeSpec,
  model: ModelId,
  seed: Anthropic.MessageParam[],
  failedText: string,
  state: LoopState,
  feedback: string,
): Promise<string> {
  const messages = buildRegulationRepairMessages(seed, failedText, feedback);
  return runToolFreeRepair(spec, model, messages, state);
}

/** Shared single-call repair: `tool_choice: 'none'` keeps the cached tool prefix stable. */
export async function runToolFreeRepair(
  spec: ModeSpec,
  model: ModelId,
  messages: Anthropic.MessageParam[],
  state: LoopState,
): Promise<string> {
  const response = await callClaude({
    model,
    systemBlocks: spec.systemBlocks,
    tools: createToolRegistry(spec.defaultTools).schemas,
    messages,
    maxTokens: spec.maxTokens,
    apiKey: state.toolContext?.anthropicApiKey,
    toolChoice: { type: 'none' },
  });
  state.cost.add(model, response.usage);
  state.servedModels.add(response.model);
  return joinTextBlocks(response.content);
}

/**
 * Time-pressure graceful degradation (A3). Finalise the best draft with an
 * explicit "Verifizierung unvollständig" banner instead of burning the
 * remaining wall-clock on a doomed retry (→ route timeout, lost report). Only
 * called for the citation family — never for hallucinated regulations or empty
 * answers. `verify.ts` is unchanged; the returned verify result stays
 * `ok: false` (honest, never a verified success); `state.verifyDegraded` drives
 * the `degraded: 'verify'` flag the UI renders as a warning, not a green check.
 */
function buildDegraded(
  text: string,
  state: LoopState,
  verify: VerifyResult,
  language: 'de' | 'en',
): OuterLoopResult {
  state.verifyDegraded = true;
  if (!state.guardrailsTriggered.includes('verify_degraded')) {
    state.guardrailsTriggered.push('verify_degraded');
  }
  return { text: prependDegradationBanner(text, language), state, verify };
}

// ───────────────────────── Inner loop ─────────────────────────

/**
 * Tool-call cycle. Runs until the model emits `end_turn` (or `max_tokens`,
 * which we treat as a finished — possibly truncated — turn) or a guard kills
 * the conversation.
 *
 * Throws `AegisError` on:
 *   - iteration overflow,
 *   - cost overflow,
 *   - upstream errors,
 *   - unexpected `stop_reason` values (`refusal`, `pause_turn`, …).
 */
async function runInnerLoop(
  spec: ModeSpec,
  state: LoopState,
  model: ModelId,
  language: 'de' | 'en',
): Promise<string> {
  const registry = createToolRegistry(spec.defaultTools, state.toolContext);
  // The pre-guard kills at `config.maxIterations`. Use the mode's own ceiling
  // (CONVERSATIONAL 10 / ASSESS 15 / CONTROL_ADVISE 20 / GAP_ANALYZE 25) instead
  // of the global default of 10 — otherwise structured modes never get past 10
  // tool iterations and fail complex documents with a non-retryable iteration_limit.
  const guardConfig = { ...DEFAULT_GUARDRAILS, maxIterations: spec.maxIterations };

  // 3.3 — accumulated answer text across `max_tokens` continuations.
  // `carryText` holds the text so far to prepend to the next continuation;
  // `maxTokensContinues` counts continuations (cap = MAX_CONTINUATIONS).
  let carryText = '';
  let maxTokensContinues = 0;

  // 3.1 — one forced, tool-free final answer instead of a hard kill. Keeps the
  // tools array intact (cache-stable) and only sets `tool_choice: none`.
  const forceAnswer = async (reason: 'iteration' | 'cost'): Promise<string> => {
    state.forcedAnswer = reason;
    state.guardrailsTriggered.push(`forced_answer:${reason}`);
    const response = await callClaude({
      model,
      systemBlocks: spec.systemBlocks,
      tools: registry.schemas,
      messages: withForceAnswerNudge(state.messages),
      maxTokens: budgetedMaxTokens(spec.maxTokens, timeLeftMs(state)),
      apiKey: state.toolContext?.anthropicApiKey,
      toolChoice: { type: 'none' },
    });
    state.cost.add(model, response.usage);
    state.servedModels.add(response.model);
    const text = `${carryText}${joinTextBlocks(response.content)}`;
    const post = applyGuardrails('post', guardConfig, { responseText: text, citations: [] });
    switch (post.action) {
      case 'ok':
        return text;
      case 'strip':
      case 'warn':
        state.guardrailsTriggered.push(post.action);
        return post.text;
      case 'fail':
        throw new AegisError('verify_failed', post.reason);
      default:
        throw new AegisError('internal_error', `Unexpected post-guard action: ${post.action}`);
    }
  };

  while (state.iteration < spec.maxIterations) {
    // 3.1 — out of budget? Force one tool-free answer rather than hard-killing.
    // Checked before the pre-guard kill (softer thresholds), so a turn that
    // would have thrown iteration_limit/cost_limit answers with what it has.
    if (state.cost.totalUsd() >= guardConfig.maxCostUsd * COST_DEGRADE_FRACTION) {
      return forceAnswer('cost');
    }
    if (state.iteration >= spec.maxIterations - 1) {
      return forceAnswer('iteration');
    }

    // ── Pre-guard ──────────────────────────────────────────────
    const preState: PreGuardState = {
      iteration: state.iteration,
      costUsd: state.cost.totalUsd(),
      contextTokens: state.cost.currentContextTokens(),
      message: '', // not consulted by iteration/cost/compress checks
    };
    const pre = applyGuardrails('pre', guardConfig, preState);
    if (pre.action === 'kill') {
      state.guardrailsTriggered.push(`kill:${pre.code}`);
      throw new AegisError(pre.code, pre.detail);
    }
    if (pre.action === 'compress') {
      state.guardrailsTriggered.push('compress');
      state.messages = await compressContext(state.messages, MemoryConfig.compactionKeepLast, callHaiku, (usage) =>
        state.cost.add(MODEL_IDS.haiku, usage),
      );
    }
    if (pre.action === 'sanitize') {
      state.guardrailsTriggered.push('sanitize');
    }
    // 'sanitize'/'ok' need no action — message-level sanitisation happens
    // once before the loop runs, on the initial user input.

    // ── Claude call ────────────────────────────────────────────
    // `max_tokens` is sized to the remaining wall-clock (budget-aware): a call
    // issued late in the run must not be able to generate past the route's
    // hard deadline. No deadline (JSON path/tests) → the spec ceiling.
    const response = await callClaude({
      model,
      systemBlocks: spec.systemBlocks,
      tools: registry.schemas,
      messages: state.messages,
      maxTokens: budgetedMaxTokens(spec.maxTokens, timeLeftMs(state)),
      apiKey: state.toolContext?.anthropicApiKey,
    });

    // Pass the raw usage straight through. The accumulator prices every bucket
    // it reports (fresh input, output, cache read, cache write) — destructuring
    // here is what previously dropped the cache buckets from the bill.
    state.cost.add(model, response.usage);
    // Record the served model (drift is emitted by callClaude on this path).
    state.servedModels.add(response.model);

    // ── Branch on stop_reason ──────────────────────────────────
    if (response.stop_reason === 'tool_use') {
      state.iteration++;
      // A tool call after a continuation means the model is reconstructing its
      // answer via retrieval — part 1 is already in `messages` as context, so
      // drop the carried prefix to avoid double-including it.
      carryText = '';
      maxTokensContinues = 0;
      state.messages.push({
        role: 'assistant',
        content: projectAssistantContent(response.content),
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await registry.execute({
          id: block.id,
          name: block.name as ToolName,
          input: block.input,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          is_error: result.is_error,
        });
        state.toolsCalled++;
        state.toolCalls.push({
          name: block.name as ToolName,
          input: block.input,
          resultPreview: result.content.slice(0, 200),
        });
        state.toolAudit?.push({
          name: block.name,
          input: block.input,
          result: result.content,
          isError: !!result.is_error,
        });
        for (const id of extractKbIds(result.content)) state.allowedIds.add(id);
      }
      state.messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // `end_turn` and `max_tokens` both produce a final (possibly truncated) text.
    if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
      const rawText = joinTextBlocks(response.content);
      let combined = `${carryText}${rawText}`;

      // 3.3 — on a `max_tokens` stop, auto-continue (up to MAX_CONTINUATIONS)
      // before accepting the answer, so long reports complete seamlessly. The
      // continuation does NOT consume a tool iteration and never re-invokes
      // tools. Time-gated: a continuation is another full model call, so with
      // less than CONTINUATION_TIME_FLOOR_MS remaining it would run into the
      // route's hard deadline mid-pass — finalise with the note instead.
      const timeForContinuation = timeLeftMs(state) >= CONTINUATION_TIME_FLOOR_MS;
      if (
        response.stop_reason === 'max_tokens' &&
        maxTokensContinues < MAX_CONTINUATIONS &&
        timeForContinuation
      ) {
        // Continue only from the text so far — never re-send a dangling tool_use
        // (would 400). No text yet → fall through and accept what we have.
        const seed = projectAssistantText(response.content);
        if (seed.length > 0) {
          maxTokensContinues += 1;
          state.guardrailsTriggered.push('max_tokens_continued');
          state.messages.push({ role: 'assistant', content: seed });
          state.messages.push({ role: 'user', content: CONTINUE_NUDGE });
          carryText = combined;
          continue;
        }
      }

      // Continuations exhausted (or time-gated) but the model still hit the
      // window → close gracefully with an explicit note instead of silently
      // truncating or blowing the deadline.
      if (
        response.stop_reason === 'max_tokens' &&
        (maxTokensContinues >= MAX_CONTINUATIONS || !timeForContinuation)
      ) {
        if (!timeForContinuation) state.guardrailsTriggered.push('continuation_time_gated');
        combined += CONTINUATION_EXHAUSTED_NOTE;
      }

      const post = applyGuardrails('post', guardConfig, {
        responseText: combined,
        citations: [],
      });

      switch (post.action) {
        case 'ok':
          return combined;
        case 'strip':
        case 'warn':
          state.guardrailsTriggered.push(post.action);
          return post.text;
        case 'fail':
          // Treat as inner-loop failure; outer loop will retry with feedback.
          throw new AegisError('verify_failed', post.reason);
        default:
          throw new AegisError(
            'internal_error',
            `Unexpected post-guard action: ${post.action}`,
          );
      }
    }

    throw new AegisError(
      'upstream_error',
      `Unexpected stop_reason "${response.stop_reason}". Aborting turn.`,
    );
  }

  throw new AegisError(
    'iteration_limit',
    `Exceeded ${spec.maxIterations} tool iterations.`,
  );
}

// ───────────────────────── Outer loop ─────────────────────────

export type OuterLoopResult = {
  text: string;
  state: LoopState;
  verify: VerifyResult;
};

/**
 * Verify-driven retry envelope. Each attempt re-runs the inner loop with the
 * accumulated state plus a synthetic user message containing the previous
 * verify failure's feedback.
 *
 * Throws `AegisError('verify_failed')` if all `maxAttempts` produce
 * unverifiable responses. `verify_failed` from the inner loop (empty post-guard
 * response) is caught here and retried like any other verify failure.
 */
export async function runOuterLoop(
  spec: ModeSpec,
  initial: LoopState,
  model: ModelId,
  language: 'de' | 'en',
  maxAttempts: number = 3,
): Promise<OuterLoopResult> {
  const state = initial;
  let lastVerify: VerifyResult | null = null;
  // The conversational seed (history + question), captured before any tool
  // scaffolding — the stable anchor every retry is rebuilt from.
  const seed = state.messages.slice();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      text = await runInnerLoop(spec, state, model, language);
    } catch (err) {
      // verify_failed from post-guard is treated as a soft failure: retry.
      // Hard errors (iteration_limit, cost_limit, upstream_error) propagate.
      // Time-gated for ALL failure types: a full retry re-runs the inner loop,
      // so without RETRY_RESERVE_MS remaining it would blow the hard deadline —
      // fail cleanly now instead of timing out mid-retry.
      if (
        err instanceof AegisError &&
        err.code === 'verify_failed' &&
        attempt < maxAttempts &&
        timeLeftMs(state) >= RETRY_RESERVE_MS
      ) {
        state.messages = trimForRetry(
          seed,
          state.messages,
          state.allowedIds,
          '', // inner threw before producing a final answer
          `[VERIFY FEEDBACK — please correct] ${err.message}\nProvide a substantive response with proper citations.`,
        );
        continue;
      }
      throw err;
    }

    const verify = verifyResponse({
      text,
      allowedIds: state.allowedIds,
      toolsCalled: state.toolsCalled,
      toolsCalledNames: state.toolCalls.map((c) => c.name),
      language,
    });
    lastVerify = verify;

    if (verify.ok) {
      return { text, state, verify };
    }

    // 3.2 — soft-only failure: hard checks passed (they run first), so accept
    // the answer with a warning instead of retrying or throwing. Counted in
    // telemetry via guardrailsTriggered (`soft_warn:<check>`).
    if (isSoftCheck(verify.failed)) {
      state.guardrailsTriggered.push(`soft_warn:${verify.failed}`);
      return { text, state, verify: warnedResult(verify.failed, verify.reason) };
    }

    // Telemetry for the ungrounded-claim blind-spot fix (once per turn). With the
    // run's exitReason downstream this yields the ungrounded-answer rate and
    // whether it recovered (exit `done`) or ended in `verify_failed`.
    if (
      verify.failed === 'unsupported_regulatory_claim' &&
      !state.guardrailsTriggered.includes('ungrounded_claim')
    ) {
      state.guardrailsTriggered.push('ungrounded_claim');
    }

    // Citation-family failure → one cheap, tool-free citation repair (reuses
    // retrieved IDs, adds no content) before the expensive full re-generation
    // retry. Re-verified by the SAME verifier. On failure → full retry below.
    // Gated by REPAIR_RESERVE: skip the repair call when too little wall-clock
    // remains to complete it (→ degrade below instead of risking a timeout).
    if (
      isCitationFamily(verify.failed) &&
      !state.guardrailsTriggered.includes('citation_repair_tried') &&
      timeLeftMs(state) >= REPAIR_RESERVE_MS
    ) {
      state.guardrailsTriggered.push('citation_repair_tried');
      try {
        const repaired = await repairCitations(spec, model, seed, text, state, `${verify.reason}\n${verify.feedback}`);
        const reverify = verifyResponse({
          text: repaired,
          allowedIds: state.allowedIds,
          toolsCalled: state.toolsCalled,
          toolsCalledNames: state.toolCalls.map((c) => c.name),
          language,
        });
        if (reverify.ok || isSoftCheck(reverify.failed)) {
          state.guardrailsTriggered.push('citation_repaired');
          return {
            text: repaired,
            state,
            verify: reverify.ok ? reverify : warnedResult(reverify.failed, reverify.reason),
          };
        }
      } catch {
        /* repair failed (model/API) → fall through to the full retry / degrade */
      }
    }

    // Hallucinated-regulation failure → one cheap, tool-free NAME repair
    // (removes/reformulates non-KB regulation names like ISO 27001, adds no
    // content) before the expensive full re-generation retry — without this,
    // a single stray standard name in a long report forces a full regen (the
    // timeout amplifier). Re-verified by the SAME verifier; on failure → full
    // retry below. No degrade banner for this family — the check stays hard.
    if (
      verify.failed === 'no_hallucinated_regulations' &&
      !state.guardrailsTriggered.includes('regulation_repair_tried') &&
      timeLeftMs(state) >= REPAIR_RESERVE_MS
    ) {
      state.guardrailsTriggered.push('regulation_repair_tried');
      try {
        const repaired = await repairRegulationNames(spec, model, seed, text, state, `${verify.reason}\n${verify.feedback}`);
        const reverify = verifyResponse({
          text: repaired,
          allowedIds: state.allowedIds,
          toolsCalled: state.toolsCalled,
          toolsCalledNames: state.toolCalls.map((c) => c.name),
          language,
        });
        if (reverify.ok || isSoftCheck(reverify.failed)) {
          state.guardrailsTriggered.push('regulation_repaired');
          return {
            text: repaired,
            state,
            verify: reverify.ok ? reverify : warnedResult(reverify.failed, reverify.reason),
          };
        }
      } catch {
        /* repair failed (model/API) → fall through to the full retry */
      }
    }

    // Time-pressure degradation (A3): a citation-family failure with too little
    // wall-clock left for a clean full retry → return the complete draft with an
    // explicit "Verifizierung unvollständig" banner instead of timing out and
    // losing the report. Citation family ONLY — hallucinated regulations / empty
    // answers still hard-fail below (never shown with a banner).
    if (isCitationFamily(verify.failed) && timeLeftMs(state) < RETRY_RESERVE_MS) {
      return buildDegraded(text, state, verify, language);
    }

    if (attempt < maxAttempts) {
      // Same time gate for ALL failure types (citation-family failures with
      // low time already degraded above and never reach this point): no time
      // for a clean full retry → clean verify_failed instead of a timeout.
      if (timeLeftMs(state) < RETRY_RESERVE_MS) {
        state.guardrailsTriggered.push('retry_time_gated');
        break;
      }
      state.messages = trimForRetry(
        seed,
        state.messages,
        state.allowedIds,
        text,
        `[VERIFY FEEDBACK — please correct] ${verify.reason}\n${verify.feedback}`,
      );
    }
  }

  throw new AegisError(
    'verify_failed',
    `Could not produce a verified response in ${maxAttempts} attempts. Last failure: ${
      lastVerify && !lastVerify.ok ? lastVerify.reason : 'unknown'
    }`,
  );
}

// ─────────────────────────── Streaming variants ───────────────────────────

/**
 * Events yielded by the streaming inner/outer loops. Mapped 1:1 to SSE
 * events by the API route — see app/api/aegis/route.ts. Token events are
 * only emitted while the model is in pure-text mode; once a `tool_use`
 * content block is detected mid-stream, a `thinking_clear` event tells
 * the client to drop any text it has shown for the current iteration
 * (it was the model's pre-tool reasoning, not the final answer).
 */
export type LoopStreamEvent =
  | { type: 'status'; phase: 'tools' | 'generating'; iteration: number; toolName?: string; message?: string }
  | { type: 'tool_result'; name: string; preview: string; isError: boolean }
  | { type: 'thinking_clear' }
  | { type: 'token'; text: string }
  | { type: 'replace_text'; text: string }
  | { type: 'verify_retry'; reason: string; feedback: string }
  // A downloadable artifact the client should surface as an attachment (e.g. the
  // Excel workbook produced by fill_template). Carries the real filename so the
  // UI never has to expose the internal download id.
  | { type: 'attachment'; downloadId: string; filename: string };

export async function* runInnerLoopStreaming(
  spec: ModeSpec,
  state: LoopState,
  model: ModelId,
): AsyncGenerator<LoopStreamEvent, string, void> {
  const registry = createToolRegistry(spec.defaultTools, state.toolContext);
  // The pre-guard kills at `config.maxIterations`. Use the mode's own ceiling
  // (CONVERSATIONAL 10 / ASSESS 15 / CONTROL_ADVISE 20 / GAP_ANALYZE 25) instead
  // of the global default of 10 — otherwise structured modes never get past 10
  // tool iterations and fail complex documents with a non-retryable iteration_limit.
  const guardConfig = { ...DEFAULT_GUARDRAILS, maxIterations: spec.maxIterations };

  // 3.3 — see runInnerLoop. Part-1 text streamed to the client already; the
  // continuation streams part 2 after it, and `carryText` joins them for the
  // returned value that verify runs on. `maxTokensContinues` counts passes.
  let carryText = '';
  let maxTokensContinues = 0;

  // 3.1 — streamed forced final answer (tool-free). Mirrors the non-streaming
  // forceAnswer but forwards tokens to the client.
  async function* forceAnswerStreaming(
    reason: 'iteration' | 'cost',
  ): AsyncGenerator<LoopStreamEvent, string, void> {
    state.forcedAnswer = reason;
    state.guardrailsTriggered.push(`forced_answer:${reason}`);
    const forcedStream = await streamClaude({
      model,
      systemBlocks: spec.systemBlocks,
      tools: registry.schemas,
      messages: withForceAnswerNudge(state.messages),
      maxTokens: budgetedMaxTokens(spec.maxTokens, timeLeftMs(state)),
      apiKey: state.toolContext?.anthropicApiKey,
      toolChoice: { type: 'none' },
    });

    let streamedText = '';
    try {
      for await (const event of forcedStream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          streamedText += event.delta.text;
          yield { type: 'token', text: event.delta.text };
        }
      }
    } catch (err) {
      throw new AegisError(
        'upstream_error',
        err instanceof Error ? `Anthropic stream error: ${err.message}` : 'Anthropic stream error',
      );
    }

    const finalMessage = await forcedStream.finalMessage();
    state.cost.add(model, finalMessage.usage);
    state.servedModels.add(finalMessage.model);
    reportModelDrift(model, finalMessage.model);

    const text = `${carryText}${streamedText}`;
    const post = applyGuardrails('post', guardConfig, { responseText: text, citations: [] });
    switch (post.action) {
      case 'ok':
        return text;
      case 'strip':
      case 'warn':
        state.guardrailsTriggered.push(post.action);
        if (post.text !== text) yield { type: 'replace_text', text: post.text };
        return post.text;
      case 'fail':
        throw new AegisError('verify_failed', post.reason);
      default:
        throw new AegisError('internal_error', `Unexpected post-guard action in stream: ${(post as { action: string }).action}`);
    }
  }

  while (state.iteration < spec.maxIterations) {
    // 3.1 — out of budget? Force one tool-free streamed answer, not a hard kill.
    if (state.cost.totalUsd() >= guardConfig.maxCostUsd * COST_DEGRADE_FRACTION) {
      return yield* forceAnswerStreaming('cost');
    }
    if (state.iteration >= spec.maxIterations - 1) {
      return yield* forceAnswerStreaming('iteration');
    }

    // ── Pre-guard ──
    const preState: PreGuardState = {
      iteration: state.iteration,
      costUsd: state.cost.totalUsd(),
      contextTokens: state.cost.currentContextTokens(),
      message: '',
    };
    const pre = applyGuardrails('pre', guardConfig, preState);
    if (pre.action === 'kill') {
      state.guardrailsTriggered.push(`kill:${pre.code}`);
      throw new AegisError(pre.code, pre.detail);
    }
    if (pre.action === 'compress') {
      state.guardrailsTriggered.push('compress');
      state.messages = await compressContext(state.messages, MemoryConfig.compactionKeepLast, callHaiku, (usage) =>
        state.cost.add(MODEL_IDS.haiku, usage),
      );
    }
    if (pre.action === 'sanitize') {
      state.guardrailsTriggered.push('sanitize');
    }

    // Stream this iteration. Tool-use detection is reactive: once a tool_use
    // content block starts, we know this iteration won't end in end_turn and
    // we stop forwarding text tokens to the client.
    const callStartedAt = Date.now();
    // Budget-aware `max_tokens` — see runInnerLoop: a late call must not be
    // able to generate past the route's hard deadline.
    const stream = await streamClaude({
      model,
      systemBlocks: spec.systemBlocks,
      tools: registry.schemas,
      messages: state.messages,
      maxTokens: budgetedMaxTokens(spec.maxTokens, timeLeftMs(state)),
      apiKey: state.toolContext?.anthropicApiKey,
    });

    let textInThisIteration = '';
    let toolUseDetected = false;
    let emittedTextSoFar = false;

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            if (emittedTextSoFar && !toolUseDetected) {
              // We streamed some pre-tool reasoning. Tell the client to drop it.
              yield { type: 'thinking_clear' };
            }
            toolUseDetected = true;
            yield {
              type: 'status',
              phase: 'tools',
              iteration: state.iteration,
              toolName: event.content_block.name,
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const text = event.delta.text;
            textInThisIteration += text;
            if (!toolUseDetected) {
              emittedTextSoFar = true;
              yield { type: 'token', text };
            }
          }
        }
      }
    } catch (err) {
      throw new AegisError(
        'upstream_error',
        err instanceof Error
          ? `Anthropic stream error: ${err.message}`
          : 'Anthropic stream error',
      );
    }

    const finalMessage = await stream.finalMessage();
    // Raw usage straight through (prices all cache buckets — see non-streaming path).
    state.cost.add(model, finalMessage.usage);
    // Streaming bypasses callClaude's drift check, so do it here.
    state.servedModels.add(finalMessage.model);
    reportModelDrift(model, finalMessage.model);
    // Telemetry: the streaming path never hit callClaude's logger, so per-call
    // timing for the main loop was invisible. Log it here (mirrors claude_call).
    console.info(
      JSON.stringify({
        event: 'claude_stream',
        model,
        iteration: state.iteration,
        stopReason: finalMessage.stop_reason,
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cachedTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
        durationMs: Date.now() - callStartedAt,
      }),
    );

    if (finalMessage.stop_reason === 'tool_use') {
      state.iteration++;
      // See runInnerLoop: a tool call after a continuation means the model is
      // rebuilding via retrieval — drop the carried prefix.
      carryText = '';
      maxTokensContinues = 0;
      state.messages.push({
        role: 'assistant',
        content: projectAssistantContent(finalMessage.content),
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of finalMessage.content) {
        if (block.type !== 'tool_use') continue;
        const result = await registry.execute({
          id: block.id,
          name: block.name as ToolName,
          input: block.input,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          is_error: result.is_error,
        });
        state.toolsCalled++;
        state.toolCalls.push({
          name: block.name as ToolName,
          input: block.input,
          resultPreview: result.content.slice(0, 200),
        });
        state.toolAudit?.push({
          name: block.name,
          input: block.input,
          result: result.content,
          isError: !!result.is_error,
        });
        for (const id of extractKbIds(result.content)) state.allowedIds.add(id);

        yield {
          type: 'tool_result',
          name: block.name,
          preview: result.content.slice(0, 200),
          isError: !!result.is_error,
        };

        // Surface a generated download as a structured attachment (full result,
        // parsed before the 200-char preview truncation) so the client can render
        // a real download link without scraping the model's prose for an id.
        if (
          (block.name === 'fill_template' ||
            block.name === 'generate_assessment_deck' ||
            block.name === 'export_assessment' ||
            block.name === 'improve_document') &&
          !result.is_error
        ) {
          try {
            const parsed = JSON.parse(result.content) as {
              downloadId?: unknown;
              filename?: unknown;
              attachments?: unknown;
            };
            // Multi-artifact tools (improve_document: improved version + change
            // log) declare a structured attachments list; single-artifact tools
            // keep the downloadId/filename pair.
            if (Array.isArray(parsed.attachments)) {
              for (const a of parsed.attachments as { downloadId?: unknown; filename?: unknown }[]) {
                if (typeof a.downloadId === 'string' && typeof a.filename === 'string') {
                  yield { type: 'attachment', downloadId: a.downloadId, filename: a.filename };
                }
              }
            } else if (typeof parsed.downloadId === 'string' && typeof parsed.filename === 'string') {
              yield { type: 'attachment', downloadId: parsed.downloadId, filename: parsed.filename };
            }
          } catch {
            // Non-JSON / unexpected shape — the prose-regex fallback still applies.
          }
        }
      }
      state.messages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (
      finalMessage.stop_reason === 'end_turn' ||
      finalMessage.stop_reason === 'max_tokens'
    ) {
      let combined = `${carryText}${textInThisIteration}`;

      // 3.3 — on a `max_tokens` stop, auto-continue (up to MAX_CONTINUATIONS).
      // Part-N tokens were already streamed; we do NOT emit thinking_clear (the
      // client keeps what it has) and simply stream the next part after it.
      // Time-gated — see runInnerLoop: below the floor a continuation would run
      // into the route's hard deadline mid-pass and cost the user the draft.
      const timeForContinuation = timeLeftMs(state) >= CONTINUATION_TIME_FLOOR_MS;
      if (
        finalMessage.stop_reason === 'max_tokens' &&
        maxTokensContinues < MAX_CONTINUATIONS &&
        timeForContinuation
      ) {
        // Continue only from the text so far — never re-send a dangling tool_use
        // (would 400). No text yet → fall through and accept what we have.
        const seed = projectAssistantText(finalMessage.content);
        if (seed.length > 0) {
          maxTokensContinues += 1;
          state.guardrailsTriggered.push('max_tokens_continued');
          state.messages.push({ role: 'assistant', content: seed });
          state.messages.push({ role: 'user', content: CONTINUE_NUDGE });
          carryText = combined;
          // Reassure the user that work continues (status only, not answer text).
          yield { type: 'status', phase: 'generating', iteration: state.iteration, message: 'Setze Bericht fort …' };
          continue;
        }
      }

      // Continuations exhausted (or time-gated) → stream + record an explicit
      // closing note rather than silently truncating or blowing the deadline.
      if (
        finalMessage.stop_reason === 'max_tokens' &&
        (maxTokensContinues >= MAX_CONTINUATIONS || !timeForContinuation)
      ) {
        if (!timeForContinuation) state.guardrailsTriggered.push('continuation_time_gated');
        yield { type: 'token', text: CONTINUATION_EXHAUSTED_NOTE };
        combined += CONTINUATION_EXHAUSTED_NOTE;
      }

      // Post-guard runs once on the assembled text. If it modifies the text
      // (strip rules removing banned phrasing) we tell the client to
      // replace what it has rendered with the corrected version.
      const post = applyGuardrails('post', guardConfig, {
        responseText: combined,
        citations: [],
      });

      switch (post.action) {
        case 'ok':
          return combined;
        case 'strip':
        case 'warn':
          state.guardrailsTriggered.push(post.action);
          if (post.text !== combined) {
            yield { type: 'replace_text', text: post.text };
          }
          return post.text;
        case 'fail':
          throw new AegisError('verify_failed', post.reason);
        default:
          throw new AegisError(
            'internal_error',
            `Unexpected post-guard action in stream: ${(post as { action: string }).action}`,
          );
      }
    }

    throw new AegisError(
      'upstream_error',
      `Unexpected stream stop_reason "${finalMessage.stop_reason}". Aborting turn.`,
    );
  }

  throw new AegisError(
    'iteration_limit',
    `Exceeded ${spec.maxIterations} tool iterations.`,
  );
}

export type OuterLoopStreamingResult = {
  text: string;
  state: LoopState;
  verify: VerifyResult;
};

export async function* runOuterLoopStreaming(
  spec: ModeSpec,
  initial: LoopState,
  model: ModelId,
  language: 'de' | 'en',
  maxAttempts: number = 3,
): AsyncGenerator<LoopStreamEvent, OuterLoopStreamingResult, void> {
  const state = initial;
  let lastVerify: VerifyResult | null = null;
  // Conversational seed (history + question) before any tool scaffolding.
  const seed = state.messages.slice();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text = '';
    let collectedFromTokens = '';
    let lastTextWasReplaced = false;

    try {
      const inner = runInnerLoopStreaming(spec, state, model);
      while (true) {
        const r = await inner.next();
        if (r.done) {
          text = r.value;
          break;
        }
        // Mirror token / replace_text events into a server-side text buffer
        // so we can run verify after the stream finishes — even if the
        // client cancelled mid-stream.
        const evt = r.value;
        if (evt.type === 'token') collectedFromTokens += evt.text;
        if (evt.type === 'replace_text') {
          collectedFromTokens = evt.text;
          lastTextWasReplaced = true;
        }
        if (evt.type === 'thinking_clear') {
          collectedFromTokens = '';
        }
        yield evt;
      }
      // Sanity: inner returned text should match what we collected from
      // token events (or the replacement). Trust the inner return value.
      if (!text && collectedFromTokens) text = collectedFromTokens;
      void lastTextWasReplaced;
    } catch (err) {
      // Time-gated for ALL failure types — see runOuterLoop.
      if (
        err instanceof AegisError &&
        err.code === 'verify_failed' &&
        attempt < maxAttempts &&
        timeLeftMs(state) >= RETRY_RESERVE_MS
      ) {
        yield { type: 'verify_retry', reason: err.message, feedback: '' };
        state.messages = trimForRetry(
          seed,
          state.messages,
          state.allowedIds,
          '', // inner threw before producing a final answer
          `[VERIFY FEEDBACK — please correct] ${err.message}\nProvide a substantive response with proper citations.`,
        );
        continue;
      }
      throw err;
    }

    const verify = verifyResponse({
      text,
      allowedIds: state.allowedIds,
      toolsCalled: state.toolsCalled,
      toolsCalledNames: state.toolCalls.map((c) => c.name),
      language,
    });
    lastVerify = verify;

    if (verify.ok) {
      return { text, state, verify };
    }

    // 3.2 — soft-only failure: accept with a warning (see runOuterLoop).
    if (isSoftCheck(verify.failed)) {
      state.guardrailsTriggered.push(`soft_warn:${verify.failed}`);
      return { text, state, verify: warnedResult(verify.failed, verify.reason) };
    }

    // Ungrounded-claim telemetry (see runOuterLoop).
    if (
      verify.failed === 'unsupported_regulatory_claim' &&
      !state.guardrailsTriggered.includes('ungrounded_claim')
    ) {
      state.guardrailsTriggered.push('ungrounded_claim');
    }

    // Citation-family failure → one cheap, tool-free citation repair before the
    // expensive full re-generation retry. On success we replace the streamed
    // draft (replace_text) with the corrected, re-verified answer. Gated by
    // REPAIR_RESERVE: skip the repair call when too little wall-clock remains.
    if (
      isCitationFamily(verify.failed) &&
      !state.guardrailsTriggered.includes('citation_repair_tried') &&
      timeLeftMs(state) >= REPAIR_RESERVE_MS
    ) {
      state.guardrailsTriggered.push('citation_repair_tried');
      try {
        const repaired = await repairCitations(spec, model, seed, text, state, `${verify.reason}\n${verify.feedback}`);
        const reverify = verifyResponse({
          text: repaired,
          allowedIds: state.allowedIds,
          toolsCalled: state.toolsCalled,
          toolsCalledNames: state.toolCalls.map((c) => c.name),
          language,
        });
        if (reverify.ok || isSoftCheck(reverify.failed)) {
          state.guardrailsTriggered.push('citation_repaired');
          yield { type: 'replace_text', text: repaired };
          return {
            text: repaired,
            state,
            verify: reverify.ok ? reverify : warnedResult(reverify.failed, reverify.reason),
          };
        }
      } catch {
        /* repair failed (model/API) → fall through to the full retry / degrade */
      }
    }

    // Hallucinated-regulation failure → one cheap, tool-free NAME repair before
    // the expensive full re-generation retry (see runOuterLoop). On success the
    // streamed draft is replaced with the corrected, re-verified answer. No
    // degrade banner for this family — the hallucination check stays hard.
    if (
      verify.failed === 'no_hallucinated_regulations' &&
      !state.guardrailsTriggered.includes('regulation_repair_tried') &&
      timeLeftMs(state) >= REPAIR_RESERVE_MS
    ) {
      state.guardrailsTriggered.push('regulation_repair_tried');
      try {
        const repaired = await repairRegulationNames(spec, model, seed, text, state, `${verify.reason}\n${verify.feedback}`);
        const reverify = verifyResponse({
          text: repaired,
          allowedIds: state.allowedIds,
          toolsCalled: state.toolsCalled,
          toolsCalledNames: state.toolCalls.map((c) => c.name),
          language,
        });
        if (reverify.ok || isSoftCheck(reverify.failed)) {
          state.guardrailsTriggered.push('regulation_repaired');
          yield { type: 'replace_text', text: repaired };
          return {
            text: repaired,
            state,
            verify: reverify.ok ? reverify : warnedResult(reverify.failed, reverify.reason),
          };
        }
      } catch {
        /* repair failed (model/API) → fall through to the full retry */
      }
    }

    // Time-pressure degradation (A3): citation-family failure with too little
    // wall-clock for a clean retry → keep the streamed report. Emit replace_text
    // with the banner-augmented draft (NOT verify_retry, which would wipe it) and
    // finalise — never a timeout that loses the report. Citation family ONLY.
    if (isCitationFamily(verify.failed) && timeLeftMs(state) < RETRY_RESERVE_MS) {
      const degraded = buildDegraded(text, state, verify, language);
      yield { type: 'replace_text', text: degraded.text };
      return degraded;
    }

    if (attempt < maxAttempts) {
      // Same time gate for ALL failure types — see runOuterLoop. No
      // verify_retry event is emitted (it would wipe the client's draft for a
      // retry that never starts); the run ends in a clean verify_failed.
      if (timeLeftMs(state) < RETRY_RESERVE_MS) {
        state.guardrailsTriggered.push('retry_time_gated');
        break;
      }
      yield { type: 'verify_retry', reason: verify.reason, feedback: verify.feedback };
      state.messages = trimForRetry(
        seed,
        state.messages,
        state.allowedIds,
        text,
        `[VERIFY FEEDBACK — please correct] ${verify.reason}\n${verify.feedback}`,
      );
    }
  }

  throw new AegisError(
    'verify_failed',
    `Could not produce a verified response in ${maxAttempts} attempts. Last failure: ${
      lastVerify && !lastVerify.ok ? lastVerify.reason : 'unknown'
    }`,
  );
}
