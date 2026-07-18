import type Anthropic from '@anthropic-ai/sdk';
import { callHaiku } from './client';
import { compressContext } from './context/compress';
import { MemoryConfig } from './memory-config';
import { CostAccumulator } from './context/cost';
import { sanitizeUserMessage } from './guardrails';
import {
  runOuterLoop,
  runOuterLoopStreaming,
  type LoopState,
  type LoopStreamEvent,
} from './loop';
import {
  appendMessage,
  createConversation,
  getConversation,
  getConversationForUser,
  getDigest,
  getSeedRows,
} from './memory';
import { applyDigestToSeed } from './digest';
import { estimateSeedTokens } from './memory-seed';
import { defaultConversationRetriever } from './memory-retrieval';
import { getModeSpec } from './modes';
import { annotateProvenance } from './provenance';
import { resolveAnthropicCredential } from './provider-settings';
import { buildVoiceNameDirective, buildVoicePrompt } from './prompts/voice';
import {
  classifyIntent,
  estimateComplexity,
  getIntentClassifier,
  applyModelPreference,
  routeToModel,
} from './router';
import {
  AegisError,
  AegisRequest,
  DEFAULT_GUARDRAILS,
  MODEL_IDS,
  type AegisResponse,
  type ToolAuditEntry,
} from './types';
import type { UsageRecorder } from './usage-recorder';
import { sectionedEnabled, startSectionedJob, triageRequest } from './sectioned/run';
import type { SectionedStreamEvent } from './sectioned/events';
import type { TriageResult } from './sectioned/triage';

/**
 * Public entry point. The only function `app/api/aegis/route.ts` and any
 * future caller (tests, MCP bridge, …) is allowed to import.
 *
 * Flow (Spec §4.9):
 *   1. Validate the request via the Zod schema (throws ZodError on bad input).
 *   2. Classify intent — only for CONVERSATIONAL, where complexity decides
 *      Haiku vs. Sonnet. Other modes have a fixed model, so we skip the
 *      Haiku call and use complexity = 0.5 as a placeholder.
 *   3. Build the mode spec (system blocks + tool subset + token ceilings).
 *   4. Seed the loop state with sanitised user input + provided history.
 *   5. Run the outer loop (which calls the inner loop, post-guards, verify).
 *   6. Extract citations from the final text and return the full response.
 */
/** Per-request options derived by the API route (not from the client body). */
export type AegisRunOptions = {
  /** Verified session id from the signed cookie — scopes document tools. */
  sessionId?: string | null;
  /** Signed-in user id — owns the conversation so history follows the account. */
  userId?: string | null;
  /**
   * Pre-rendered style-only personalization block (soul.md). Injected as an
   * UNCACHED trailing system block so it never breaks the cached identity+mode
   * prefix, and is explicitly subordinated to grounding/verification by its own
   * text (see lib/aegis/soul.ts → soulSystemBlock).
   */
  soulBlock?: string | null;
  /**
   * Spoken first name (voice mode only). When present, Aegis addresses the user
   * by name once at the end of the answer. Injected as an UNCACHED block so the
   * generic voice overlay stays cache-shared across users.
   */
  firstName?: string | null;
  /**
   * Absolute wall-clock deadline (ms epoch) for this run — the streaming route's
   * hard timeout. Threaded onto the LoopState so the outer loop can gate
   * expensive verify recovery against the remaining time (graceful degradation).
   * Omitted on the non-streaming JSON path → the loop treats time as unbounded.
   */
  deadlineAt?: number;
  /** Optional per-request Anthropic API key loaded from encrypted BYOK settings. */
  anthropicApiKey?: string | null;
};

/**
 * Map the loop's graceful-degradation state to the response `degraded` value.
 * Forced-answer (iteration/cost) takes precedence; `verify` marks a complete
 * report whose citation verification could not finish in the wall-clock budget.
 */
function degradedReason(state: LoopState): AegisResponse['degraded'] {
  return state.forcedAnswer ?? (state.verifyDegraded ? 'verify' : undefined);
}

/** Append the style-only soul block as an uncached trailing system block. */
function withSoulBlock(spec: ReturnType<typeof getModeSpec>, soulBlock?: string | null) {
  if (!soulBlock) return spec;
  return {
    ...spec,
    systemBlocks: [...spec.systemBlocks, { text: soulBlock, cached: false }],
  };
}

/**
 * 3.1 — map a forced (degraded) answer to its distinct exitReason for the usage
 * dashboard. Returns null on a clean finish so the caller falls back to 'done'.
 */
function forcedExitReason(state: LoopState): 'forced_answer' | 'forced_answer_cost' | null {
  if (state.forcedAnswer === 'cost') return 'forced_answer_cost';
  if (state.forcedAnswer === 'iteration') return 'forced_answer';
  return null;
}

// ─────────────────────────── Conversation memory ───────────────────────────

type MemoryTurn = {
  conversationId: string;
  /** Replay seed: complete user/assistant pairs only, text-only turns. */
  seed: Anthropic.MessageParam[];
  /** Estimated tokens of `seed` (chars/3.5 for de) — pre-flight compaction check. */
  seedTokens: number;
  userPersisted: boolean;
};

/**
 * Resolve conversation memory for this run:
 *   - explicit `conversationId` → ownership-scoped load; unknown/foreign/
 *     expired throws `AegisError('not_found')` (the one non-fail-open case —
 *     it's a caller error, not an infra failure),
 *   - no id → create a conversation owned by the session,
 *   - persist the user turn (fail-open),
 *   - build the replay seed from COMPLETE pairs only (amendment 3).
 *
 * Returns null when the run is stateless (no session) or memory infra is
 * unavailable — the run then behaves exactly like pre-Phase-2.
 */
async function startMemoryTurn(
  req: AegisRequest,
  sessionId: string | null,
  userId: string | null,
  sanitizedMessage: string,
): Promise<MemoryTurn | null> {
  if (!sessionId) return null;

  try {
    let conversationId: string;
    let seed: Anthropic.MessageParam[] = [];
    let seedTokens = 0;

    if (req.conversationId) {
      // Owned by this browser session OR the signed-in user (so a conversation
      // opened from history on another device can still be continued).
      const conversation =
        (await getConversation(req.conversationId, sessionId)) ??
        (await getConversationForUser(req.conversationId, userId));
      if (!conversation) {
        throw new AegisError(
          'not_found',
          'Unterhaltung nicht gefunden oder abgelaufen.',
          req.conversationId,
        );
      }
      conversationId = conversation.id;
      const rows = await getSeedRows(conversationId);
      // Context compaction (Phase 2): if a digest exists, replay it in place of
      // the turns it covers and only seed later turns verbatim. No digest →
      // identical to the pre-Phase-2 path.
      const stored = await getDigest(conversationId);
      const seedRows = stored ? rows.filter((r) => r.seq > stored.throughSeq) : rows;
      // Working-memory selection goes through the ConversationRetriever seam so a
      // future semantic retriever can replace chronological loading without
      // touching this call site. Default impl = recent pairs under the seed budget.
      const built = defaultConversationRetriever.retrieve({
        messages: seedRows,
        language: req.language,
      });
      const withDigest = stored ? applyDigestToSeed(stored.digest, built) : built;
      seed = withDigest.map((m) => ({ role: m.role, content: m.content }));
      seedTokens = estimateSeedTokens(withDigest, req.language);
    } else {
      const created = await createConversation({
        sessionId,
        userId,
        mode: req.mode,
        language: req.language,
        firstUserMessage: sanitizedMessage,
      });
      if (!created) return null; // infra failure already logged — stateless turn
      conversationId = created;
    }

    const userSeq = await appendMessage(conversationId, {
      role: 'user',
      content: sanitizedMessage,
    });

    return { conversationId, seed, seedTokens, userPersisted: userSeq !== null };
  } catch (err) {
    if (err instanceof AegisError) throw err;
    console.error(
      JSON.stringify({
        event: 'aegis_memory_unavailable',
        level: 'error',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** Persist the assistant turn (fail-open). Returns true when the row landed. */
async function persistAssistantTurn(
  memory: MemoryTurn | null,
  turn: {
    content: string;
    citedIds: string[];
    status: 'complete' | 'failed';
    exitReason: string;
    model: string;
    mode: string;
    toolAudit: ToolAuditEntry[];
    traceId?: string;
  },
): Promise<boolean> {
  if (!memory) return false;
  const seq = await appendMessage(memory.conversationId, {
    role: 'assistant',
    content: turn.content,
    citedIds: turn.citedIds,
    status: turn.status,
    exitReason: turn.exitReason,
    model: turn.model,
    mode: turn.mode,
    toolCalls: turn.toolAudit,
    traceId: turn.traceId,
  });
  return seq !== null;
}

/**
 * Seed assembly shared by both entry points. When memory resolved, the server
 * transcript is authoritative and client-supplied `history` is ignored;
 * stateless (legacy) callers keep the old history behaviour. If the loaded
 * seed exceeds the soft budget (single oversized pair), run pre-flight
 * compaction — closing the "compaction can't fire before the first call" gap.
 */
async function assembleSeed(
  req: AegisRequest,
  memory: MemoryTurn | null,
  sanitizedMessage: string,
  recorder?: UsageRecorder,
): Promise<Anthropic.MessageParam[]> {
  const userTurn = { role: 'user' as const, content: sanitizedMessage };
  let messages: Anthropic.MessageParam[] = memory
    ? [...memory.seed, userTurn]
    : [
        ...req.history.map((h) => ({ role: h.role, content: h.content })),
        userTurn,
      ];

  if (memory && memory.seedTokens > DEFAULT_GUARDRAILS.seedTokenBudget) {
    messages = await compressContext(messages, MemoryConfig.compactionKeepLast, callHaiku, (usage) =>
      recorder?.cost.add(MODEL_IDS.haiku, usage),
    );
  }
  return messages;
}

export async function runAegis(
  input: unknown,
  recorder?: UsageRecorder,
  options?: AegisRunOptions,
): Promise<AegisResponse> {
  const req = AegisRequest.parse(input);
  const sessionId = options?.sessionId ?? null;
  const userId = options?.userId ?? null;
  const sanitized = sanitizeUserMessage(req.message);
  const resolvedAnthropic = options?.anthropicApiKey
    ? { apiKey: options.anthropicApiKey }
    : await resolveAnthropicCredential(userId).catch((err) => {
        throw new AegisError('invalid_input', err instanceof Error ? err.message : 'AI-Provider ist für AEGIS nicht verfügbar.');
      });

  // Memory start: resolve/create the conversation and persist the user turn
  // before anything that can fail downstream. Throws only `not_found`.
  const memory = await startMemoryTurn(req, sessionId, userId, sanitized);
  const conversationId =
    memory?.conversationId ?? req.conversationId ?? crypto.randomUUID();
  recorder?.setMeta({ conversationId, mode: req.mode, language: req.language });

  // Routing — only CONVERSATIONAL needs a complexity estimate. The heuristic
  // (3.4) avoids the blocking Haiku call; gated behind AEGIS_INTENT_CLASSIFIER,
  // which defaults to 'haiku' so deploy changes no routing until we flip it.
  let complexity = 0.5;
  if (req.mode === 'CONVERSATIONAL') {
    if (getIntentClassifier() === 'heuristic') {
      complexity = estimateComplexity(req.message);
    } else {
      const intent = await classifyIntent(req.message, callHaiku, (usage) =>
        recorder?.cost.add(MODEL_IDS.haiku, usage),
      );
      complexity = intent.complexity;
    }
  }
  const route = applyModelPreference(routeToModel(req.mode, complexity), resolvedAnthropic);
  recorder?.setMeta({ model: route.model });
  const baseSpec = getModeSpec(req.mode, req.language);
  if (req.voice) {
    baseSpec.maxIterations = 5;
    baseSpec.maxTokens = 1024;
    // Spoken-style overlay: brevity + natural German + one follow-up. Added to
    // the cached prefix (before the uncached soul block) so voice turns share a
    // cache hit. Citations stay inline; the client strips them from the audio.
    baseSpec.systemBlocks = [
      ...baseSpec.systemBlocks,
      { text: buildVoicePrompt(req.language), cached: true },
    ];
    if (options?.firstName) {
      baseSpec.systemBlocks = [
        ...baseSpec.systemBlocks,
        { text: buildVoiceNameDirective(req.language, options.firstName), cached: false },
      ];
    }
  }
  const spec = withSoulBlock(baseSpec, options?.soulBlock);

  const messages = await assembleSeed(req, memory, sanitized, recorder);

  // Shared with the tool-context usage hook so tool-level model spend
  // (conversation-findings extraction) lands in the same accumulator.
  const costAcc = recorder?.cost ?? new CostAccumulator();
  const initialState: LoopState = {
    messages,
    iteration: 0,
    // Share the recorder's accumulator so cost is captured even if the loop
    // throws before returning (cost cap, verify exhaustion, upstream error).
    cost: costAcc,
    toolCalls: [],
    toolsCalled: 0,
    allowedIds: new Set<string>(),
    servedModels: new Set<string>(),
    guardrailsTriggered: [],
    toolContext: {
      sessionId,
      userId,
      conversationId,
      onUsage: (model, usage) => costAcc.add(model, usage),
      anthropicApiKey: resolvedAnthropic?.apiKey ?? null,
    },
    toolAudit: [],
  };

  try {
    const { text: rawText, state, verify } = await runOuterLoop(
      spec,
      initialState,
      route.model,
      req.language,
    );

    // Deterministic provenance annotations (unverified-source banner +
    // citation verification footer) — applied AFTER verify accepted the text.
    const text = annotateProvenance({
      text: rawText,
      toolNames: state.toolCalls.map((c) => c.name),
      language: req.language,
      voice: req.voice,
    });

    const citations = Array.from(
      new Set(
        Array.from(rawText.matchAll(/\[(R-[A-Z0-9]+-[A-Z0-9-]+)\]/g)).map(
          (m) => m[1],
        ),
      ),
    );

    // 3.1 — distinguish a forced (degraded) answer from a clean finish so the
    // dashboard can track how often turns hit the iteration/cost ceiling. A
    // time-pressure verify degradation is its own exit reason (verifyPassed
    // stays false below — never recorded as a verified success).
    const exitReason =
      forcedExitReason(state) ?? (state.verifyDegraded ? 'verify_degraded' : 'done');

    recorder?.setMeta({
      exitReason,
      verifyPassed: verify.ok,
      citationCount: citations.length,
    });

    const persisted = await persistAssistantTurn(memory, {
      content: text,
      citedIds: citations,
      status: 'complete',
      exitReason,
      model: route.model,
      mode: req.mode,
      toolAudit: state.toolAudit ?? [],
      traceId: recorder?.traceId,
    });

    return {
      text,
      citations,
      conversationId,
      modelUsed: route.model,
      iterations: state.iteration,
      toolCalls: state.toolCalls,
      cost: state.cost.breakdown(),
      verify,
      persisted,
      degraded: degradedReason(state),
    };
  } catch (err) {
    const exitReason = err instanceof AegisError ? err.code : 'internal_error';
    recorder?.setMeta({ exitReason });
    // Failed turns are history too (mirrors the usage-log philosophy).
    await persistAssistantTurn(memory, {
      content: '',
      citedIds: [],
      status: 'failed',
      exitReason,
      model: route.model,
      mode: req.mode,
      toolAudit: initialState.toolAudit ?? [],
      traceId: recorder?.traceId,
    });
    // Attach conversationId to AegisError so the route can echo it to the client.
    if (err instanceof AegisError && !err.conversationId) {
      throw new AegisError(err.code, err.message, conversationId);
    }
    throw err;
  } finally {
    // `initialState` is mutated in place by the loop, so these reflect the last
    // iteration reached even on the error path.
    recorder?.setMeta({
      iterations: initialState.iteration,
      toolCalls: initialState.toolCalls.length,
      servedModels: [...initialState.servedModels],
      guardrailsTriggered: initialState.guardrailsTriggered,
    });
  }
}

// ─────────────────────────── Streaming entry ───────────────────────────

/**
 * Yielded by `runAegisStreaming`. Mirrors `LoopStreamEvent` for the
 * forwarding events plus a terminal `done` (verify passed) or `error`.
 */
export type AegisStreamEvent =
  | LoopStreamEvent
  // SECTIONED-only events (epic F5): emitted exclusively when the sectioned
  // pipeline is enabled AND triage routed the turn there. The SINGLE_PASS
  // event set below stays byte-identical.
  | SectionedStreamEvent
  | {
      type: 'done';
      response: string;
      citations: string[];
      meta: {
        mode: string;
        model: string;
        cost: ReturnType<CostAccumulator['breakdown']>;
        latency: number;
        verification: AegisResponse['verify'];
        conversationId: string;
        iterations: number;
        toolCalls: AegisResponse['toolCalls'];
        /** False when the turn could not be written to memory (fail-open). */
        persisted: boolean;
        /** 3.1 — set when the answer was forced out at the ceiling (may be incomplete). */
        degraded?: AegisResponse['degraded'];
      };
    }
  | { type: 'error'; code: string; message: string; conversationId: string };

/**
 * Streaming variant of `runAegis`. Yields events for each tool call,
 * each token of the final response, and a terminal `done` event with
 * the same metadata shape as the non-streaming JSON response. Used by
 * the SSE branch of `app/api/aegis/route.ts`.
 */
export async function* runAegisStreaming(
  input: unknown,
  recorder?: UsageRecorder,
  options?: AegisRunOptions,
): AsyncGenerator<AegisStreamEvent, void, void> {
  const startedAt = Date.now();

  let req: ReturnType<typeof AegisRequest.parse>;
  try {
    req = AegisRequest.parse(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation failed';
    yield {
      type: 'error',
      code: 'invalid_input',
      message,
      conversationId: 'unknown',
    };
    return;
  }

  const sessionId = options?.sessionId ?? null;
  const userId = options?.userId ?? null;
  const sanitized = sanitizeUserMessage(req.message);
  let resolvedAnthropic: { apiKey: string } | null = null;
  try {
    resolvedAnthropic = options?.anthropicApiKey
      ? { apiKey: options.anthropicApiKey }
      : await resolveAnthropicCredential(userId);
  } catch (err) {
    recorder?.setMeta({ exitReason: 'invalid_input' });
    yield {
      type: 'error',
      code: 'invalid_input',
      message: err instanceof Error ? err.message : 'AI-Provider ist für AEGIS nicht verfügbar.',
      conversationId: req.conversationId ?? 'unknown',
    };
    return;
  }

  let memory: MemoryTurn | null = null;
  try {
    memory = await startMemoryTurn(req, sessionId, userId, sanitized);
  } catch (err) {
    if (err instanceof AegisError) {
      recorder?.setMeta({ exitReason: err.code });
      yield {
        type: 'error',
        code: err.code,
        message: err.message,
        conversationId: req.conversationId ?? 'unknown',
      };
      return;
    }
    memory = null; // startMemoryTurn already logged — stateless turn
  }
  const conversationId =
    memory?.conversationId ?? req.conversationId ?? crypto.randomUUID();
  recorder?.setMeta({ conversationId, mode: req.mode, language: req.language });

  let complexity = 0.5;
  // F7: when the sectioned pipeline is enabled, ONE combined Haiku triage call
  // (mode + complexity + deliverableKind) replaces classifyIntent for this
  // turn. Voice turns skip triage and are always SINGLE_PASS. A stateless turn
  // (no conversation row) cannot own an AegisJob (F2), so it also stays
  // single-pass. Flag off → the pre-existing path below, byte-identical.
  let triage: TriageResult | null = null;
  const sectionedCandidate =
    sectionedEnabled() && !req.voice && memory !== null && options?.deadlineAt !== undefined;
  if (sectionedCandidate) {
    triage = await triageRequest(sanitized, (usage) =>
      recorder?.cost.add(MODEL_IDS.haiku, usage),
    );
    if (req.mode === 'CONVERSATIONAL') complexity = triage.complexity;
  } else if (req.mode === 'CONVERSATIONAL') {
    if (getIntentClassifier() === 'heuristic') {
      complexity = estimateComplexity(req.message);
    } else {
      try {
        const intent = await classifyIntent(req.message, callHaiku, (usage) =>
          recorder?.cost.add(MODEL_IDS.haiku, usage),
        );
        complexity = intent.complexity;
      } catch {
        /* fall through to default complexity */
      }
    }
  }
  const route = applyModelPreference(routeToModel(req.mode, complexity), resolvedAnthropic);
  recorder?.setMeta({ model: route.model });
  const baseSpec = getModeSpec(req.mode, req.language);
  if (req.voice) {
    baseSpec.maxIterations = 5;
    baseSpec.maxTokens = 1024;
    // Spoken-style overlay: brevity + natural German + one follow-up. Added to
    // the cached prefix (before the uncached soul block) so voice turns share a
    // cache hit. Citations stay inline; the client strips them from the audio.
    baseSpec.systemBlocks = [
      ...baseSpec.systemBlocks,
      { text: buildVoicePrompt(req.language), cached: true },
    ];
    if (options?.firstName) {
      baseSpec.systemBlocks = [
        ...baseSpec.systemBlocks,
        { text: buildVoiceNameDirective(req.language, options.firstName), cached: false },
      ];
    }
  }
  const spec = withSoulBlock(baseSpec, options?.soulBlock);

  const messages = await assembleSeed(req, memory, sanitized, recorder);
  // Shared with the tool-context usage hook (see runAegis).
  const costAcc = recorder?.cost ?? new CostAccumulator();
  const initialState: LoopState = {
    messages,
    iteration: 0,
    // Share the recorder's accumulator (see runAegis) so an aborted or errored
    // stream still records the tokens that were already billed.
    cost: costAcc,
    toolCalls: [],
    toolsCalled: 0,
    allowedIds: new Set<string>(),
    servedModels: new Set<string>(),
    guardrailsTriggered: [],
    toolContext: {
      sessionId,
      userId,
      conversationId,
      onUsage: (model, usage) => costAcc.add(model, usage),
      anthropicApiKey: resolvedAnthropic?.apiKey ?? null,
    },
    toolAudit: [],
    // Wall-clock deadline for time-budget-aware verify recovery (graceful
    // degradation). Undefined → unbounded (non-streaming / tests).
    deadlineAt: options?.deadlineAt,
  };

  // Switch the generating phase as soon as the first token arrives.
  let inGenerating = false;
  let finalText = '';
  // One terminal memory write per run, no matter which exit path fires
  // (done, caught error, or the route's gen.return() on timeout → finally).
  let turnPersisted = false;
  const persistTerminalTurn = async (turn: {
    content: string;
    citedIds: string[];
    status: 'complete' | 'failed';
    exitReason: string;
  }): Promise<boolean> => {
    if (turnPersisted) return false;
    turnPersisted = true;
    return persistAssistantTurn(memory, {
      ...turn,
      model: route.model,
      mode: req.mode,
      toolAudit: initialState.toolAudit ?? [],
      traceId: recorder?.traceId,
    });
  };

  // ── SECTIONED delegation (Station 2, flag-gated) ──
  // Runs plan → job → executor and streams section events. A plan failure
  // falls through silently to the single-pass path below (iron rule). The
  // sectioned path owns its persistence: the assembled report lands as an
  // AegisMessage on job completion (possibly in a later resume invocation),
  // so the single-pass terminal write is skipped for delegated runs.
  if (triage?.deliverableStrategy === 'SECTIONED' && memory) {
    const sectioned = startSectionedJob({
      conversationId,
      mode: req.mode,
      baseSpec: spec,
      language: req.language,
      userMessage: sanitized,
      deadlineAt: options?.deadlineAt ?? Date.now() + 290_000,
      cost: costAcc,
      toolContext: initialState.toolContext,
      toolAudit: initialState.toolAudit,
    });
    let outcome: Awaited<ReturnType<typeof sectioned.next>>;
    while (!(outcome = await sectioned.next()).done) {
      yield outcome.value;
    }
    if (outcome.value.kind === 'ran') {
      const status = outcome.value.outcome.status;
      recorder?.setMeta({
        exitReason: status === 'done' ? 'sectioned_done' : `sectioned_${status}`,
      });
      turnPersisted = true; // job store owns persistence for sectioned runs
      return;
    }
    // fallback_single_pass → continue below, stream untouched (nothing yielded).
  }

  try {
    const outer = runOuterLoopStreaming(spec, initialState, route.model, req.language);
    while (true) {
      const r = await outer.next();
      if (r.done) {
        const { text: rawText, state, verify } = r.value;
        // Deterministic provenance annotations — the appended part is
        // streamed as a trailing `token` event so the client draft stays
        // intact and ends up identical to the persisted message.
        const text = annotateProvenance({
          text: rawText,
          toolNames: state.toolCalls.map((c) => c.name),
          language: req.language,
          voice: req.voice,
        });
        if (text !== rawText) {
          yield { type: 'token', text: text.slice(rawText.length) };
        }
        finalText = text;
        const citations = Array.from(
          new Set(
            Array.from(rawText.matchAll(/\[(R-[A-Z0-9]+-[A-Z0-9-]+)\]/g)).map(
              (m) => m[1],
            ),
          ),
        );
        const exitReason =
          forcedExitReason(state) ?? (state.verifyDegraded ? 'verify_degraded' : 'done');
        recorder?.setMeta({
          exitReason,
          verifyPassed: verify.ok,
          citationCount: citations.length,
        });
        const persisted = await persistTerminalTurn({
          content: text,
          citedIds: citations,
          status: 'complete',
          exitReason,
        });
        yield {
          type: 'done',
          response: text,
          citations,
          meta: {
            mode: req.mode,
            model: route.model,
            cost: state.cost.breakdown(),
            latency: Date.now() - startedAt,
            verification: verify,
            conversationId,
            iterations: state.iteration,
            toolCalls: state.toolCalls,
            persisted,
            degraded: degradedReason(state),
          },
        };
        return;
      }
      const evt = r.value;
      // Insert a one-shot 'generating' status when the first token arrives
      // so the UI knows tool phase is over.
      if (evt.type === 'token' && !inGenerating) {
        inGenerating = true;
        yield {
          type: 'status',
          phase: 'generating',
          iteration: initialState.iteration,
        };
      }
      // After a verify_retry, we re-enter tool phase from scratch.
      if (evt.type === 'verify_retry') inGenerating = false;
      yield evt;
    }
  } catch (err) {
    const code = err instanceof AegisError ? err.code : 'internal_error';
    const message =
      err instanceof Error ? err.message : 'Unexpected error in AEGIS stream';
    recorder?.setMeta({ exitReason: code });
    await persistTerminalTurn({
      content: '',
      citedIds: [],
      status: 'failed',
      exitReason: code,
    });
    yield {
      type: 'error',
      code,
      message,
      conversationId,
    };
  } finally {
    // Reference the captured text so the variable is not flagged as unused
    // when the loop ends without producing a done event.
    void finalText;
    // Covers exits that bypass both terminal paths above: the route's 270s
    // timeout (gen.return()) and client cancel. Mirrors the recorder's
    // default 'aborted' exit reason.
    if (!turnPersisted) {
      await persistTerminalTurn({
        content: '',
        citedIds: [],
        status: 'failed',
        exitReason: 'aborted',
      });
    }
    // `initialState` is mutated in place, so these reflect the last iteration
    // reached even when the stream errors or is aborted before `done`.
    recorder?.setMeta({
      iterations: initialState.iteration,
      toolCalls: initialState.toolCalls.length,
      servedModels: [...initialState.servedModels],
      guardrailsTriggered: initialState.guardrailsTriggered,
    });
  }
}

export type { AegisRequest, AegisResponse } from './types';
export { UsageRecorder } from './usage-recorder';
