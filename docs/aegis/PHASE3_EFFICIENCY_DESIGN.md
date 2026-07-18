# Phase 3 — Harness Efficiency: Design

Approved design for Phase 3 (cost & latency). Branch `phase-3-efficiency` off
`main` (`6f2a52c`). Compiled from the full code review + the approved proposal
with amendments folded in (amendments override the original proposal where they
conflict).

Each item is its own gated commit (`nvm use 22 && npx tsc --noEmit && npx vitest
run`) with tests for its new behaviour / exit paths. Two invariants hold on
every item:

- **Byte-stable cache prefix** — the Phase-2 discipline. Anything that changes
  the system blocks / tool list / message prefix breaks the Anthropic prompt
  cache; changes that must happen are one-time and called out per item.
- **All-exits cost tracking** — `state.cost` *is* the recorder's accumulator
  (`index.ts`), and `recorder.flush()` runs in `finally`/`cancel` on both route
  paths (`route.ts:149/160/280`). Every new exit path must (a) route any new
  model call's usage through `state.cost.add()`, and (b) set a distinct
  `exitReason` via `recorder.setMeta` so the dashboard's `exitReasonSplit`
  categorises it.

## Implementation order

`3.6 → 3.4 → 3.7 → 3.5 → 3.3 → 3.1 → 3.2`

Rationale: 3.6 (client retry) is foundational and isolated; 3.4/3.7/3.5 are
isolated to their own files; the loop trio 3.3→3.1→3.2 is sequenced inner→outer
so commits stay localised. 3.1 and 3.6 both touch `client.ts` (different
regions); 3.1, 3.3 both touch `runInnerLoop`/`runInnerLoopStreaming`; 3.2 touches
the outer loop. Every loop change is applied to **both** the sync and streaming
variant in the same commit.

---

## 3.6 — Retry / cache interplay (`client.ts`)

**Problem.** `shouldRetry` covers only 429/503, but the SDK client uses the
default `maxRetries: 2`, which *also* retries `APIConnectionError` (connection
resets), 408, 409, 429, and ≥500. The two layers double-retry, and naively
setting `maxRetries: 0` would silently drop connection-reset / 408 / 409 / 5xx
coverage.

**Change.**
1. Expand `shouldRetry` to a **superset** of the SDK's policy:
   `instanceof Anthropic.APIConnectionError` (covers resets + timeouts) **plus**
   status ∈ {408, 409, 429, 500, 502, 503, 504}.
2. Set `maxRetries: 0` on the singleton client so the custom policy is
   authoritative.
3. Bump custom attempts 2 → 3 (matches the SDK's 2 retries = 3 total tries).
4. Add a **manual one-shot retry around stream creation, before the first byte**
   — `streamClaude` loses the SDK's initial-connect retry under `maxRetries: 0`;
   restore it for the connection-establishment phase only (mid-stream retries
   stay forbidden — non-idempotent once bytes are sent).

**Invariants.** Request object is built **once** and reused across attempts
(already true at `callClaude`) so attempts 2–3 share a byte-identical cache
prefix. No exit-path change.

---

## 3.4 — Cheaper intent classification (`router.ts`, `index.ts`)

**Problem.** A blocking Haiku `classifyIntent` call runs on every CONVERSATIONAL
turn (~300–500 ms first-token latency). `mode` already comes from `req.mode`; for
CONVERSATIONAL only `complexity` is consumed (escalation threshold 0.5).

**Change.** Add a pure heuristic that produces `complexity ∈ [0,1]` from message
features: distinct KB regulation-name count (reuse verify.ts
`REGULATION_MENTION`/`KNOWN_REGULATIONS`), cross-regulation keywords (`vs`,
`compare`, `difference`, `unterschied`, `vergleich`, `beide`, `crosswalk`),
length, and `?` count. Gate behind `AEGIS_INTENT_CLASSIFIER`.

**Amendment (overrides proposal).** The code **DEFAULT stays `'haiku'`** — no
routing change on deploy. Bias the heuristic score toward **Sonnet** when
uncertain. We flip the env to `'heuristic'` deliberately later, after validating
against real queries — **not** in this commit.

**Invariants.** Heuristic *removes* a call; no main-loop prefix impact. Cost
unaffected (the Haiku helper already records via `recorder.cost.add`).

---

## 3.7 — Prompt / tool hygiene (`prompts/identity.ts`)

**Shifted since the plan.** The stub-tool concern is already resolved:
`generate_report` is a stub but **not advertised in any `MODE_TOOLS`**;
`analyze_document`/`fill_template` became real when Phase 1.1 landed. Only the KB
table-of-contents sub-item remains.

**Change.** Add a compact KB table-of-contents (regulations × counts) to the
cached identity block so the model filters instead of guessing.

**Amendment (overrides proposal).** The TOC must be **deterministically ordered
(sorted by regulation id), built once at module load, never per-request**, so it
is byte-identical across instances.

**Invariants.** One-time fleet cache invalidation on deploy (own commit, so it's
attributable). Static string → prefix stays byte-stable across requests/instances.

---

## 3.5 — Fewer body-fetch round trips (`tools/search_kb.ts` + registry)

**Problem.** `search_kb` strips the `body` field; fetching a body means
re-querying by ID — one round trip per body.

**Change (amendment confirms).** Add a **`get_requirements(ids[])` batch tool**
(not `include_body`) — the model fetches N full records in one round trip by ID.
Matches the existing "re-query by ID" idiom, just batched, with no wasted bodies.

**Invariants.** Adds one advertised tool → one-time tool-list cache change. New
tool's executor records nothing billable (pure KB lookup), so no cost-path change.

---

## 3.3 — max_tokens continuation (`loop.ts` inner ×2)

**Problem.** `stop_reason === 'max_tokens'` is treated as a finished (truncated)
turn → straight to post-guard/return, so a truncated answer fails verify and
burns a full retry.

**Change.** On `max_tokens`, continue the turn **once** — append the partial
assistant text + a "continue" user turn and re-call — before letting the result
proceed to verify. Applied to both `runInnerLoop` and `runInnerLoopStreaming`.

**Invariants.** Continuation = same prefix + appended assistant-partial +
"continue" user turn → append-only, prefix stable. The continuation call's usage
flows through the existing `state.cost.add()`. No new terminal exitReason (still
ends `end_turn`/`done`), but a `max_tokens_continued` guardrail token is recorded
for visibility.

---

## 3.1 — Graceful degradation (`loop.ts` inner ×2, `client.ts` `tool_choice`)

**Problem.** Near the iteration ceiling or the cost cap, the loop hard-throws
`iteration_limit` / `cost_limit`, discarding 100% of the run's spend.

**Change.** When `iteration === maxIterations - 1`, or `costUsd` is within ~20%
of `maxCostUsd` (≥ 0.8 × cap), inject an "answer now with what you have; no more
tools" user turn and make one final call with `tool_choice: 'none'`. Only throw
if even that fails. Applied to both inner-loop variants.

**Amendment (overrides proposal).** Force "answer now" via `tool_choice: 'none'`
as a **top-level param — never drop the tools array** (dropping it busts the
tool-list cache breakpoint). Record the forced call's usage; set a distinct
`exitReason` — `forced_answer` (iteration ceiling) / `forced_answer_cost` (cost
cap).

**Invariants.** `tool_choice` is a top-level request param, not part of the
cached blocks; tools array unchanged → prefix stays cache-hot. Forced call's
usage via `state.cost.add()`; new exitReasons surfaced to the dashboard.

---

## 3.2 — Tiered verification (`loop.ts` outer ×2, `verify.ts`, `types.ts`)

**Problem.** Any final-attempt verify failure throws `verify_failed`, discarding
a usable answer that only tripped a soft check.

**Change.** Split checks:
- **Hard** (retry, then throw `verify_failed`): `citation_coverage`,
  `no_hallucinated_regulations`, `non_empty_response`.
- **Soft** (return the answer with a `warnings` field instead of throwing):
  `language_consistency`, `no_false_ignorance`.

`verifyResponse` already orders hard checks (1–3) before soft (4–5) and
short-circuits on first failure, so a returned soft failure guarantees the hard
checks passed. Export `SOFT_CHECKS`; the outer loop decides. **Short-circuit on a
soft-only failure** — warn-and-return immediately rather than burning the
remaining retries.

**Amendment (overrides proposal).**
1. The UI must render a distinct **"verified with warnings"** state — never
   "✓ Verifiziert (5/5)" on a warned answer.
2. Instrument **per-check soft-fail counts** in telemetry.
3. Do **not** add a `language_consistency` retry yet — just count it.

**Invariants.** Soft-warn path makes **no** model call (verify is deterministic)
→ no cache impact. Returns normally → flush fires; set `exitReason: 'done_warned'`
so warned answers are distinguishable in the dashboard.

---

## After 3.2

STOP. Do **not** merge `phase-3-efficiency` to `main`. Shipping to prod is a
separate gated sequence (preview smoke → merge) run once the phase is complete
and reviewed.
