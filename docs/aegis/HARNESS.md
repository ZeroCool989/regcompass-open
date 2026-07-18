# AEGIS Harness — How It Works (Notes)

> A field guide to the AEGIS agent harness in RegCompass: what each part is **for**,
> the **function** that does it, the **code** (commented), and **why** the decision
> was made. Structured to match the "agent harness anatomy" + CoALA memory model.
>
> **One-line thesis (the IBM point):** the model is a black box you rent; reliability
> comes from the **deterministic code around it** — routing, tools, guardrails,
> verify, accounting. AEGIS is that code.

---

## 0. Mental model

```
            ┌─────────────────────── the HARNESS (deterministic code) ───────────────────────┐
 HTTP POST  │                                                                                 │
 ─────────► │  rate-limit → validate → classify intent → route model → build mode spec        │
 /api/aegis │        │                                                                        │
            │        ▼                                                                        │
            │   ┌── OUTER LOOP (verify-retry, ≤3) ──────────────────────────────────────┐    │
            │   │   ┌── INNER LOOP (tool cycle) ──────────────────────────────────┐      │    │
            │   │   │  pre-guards → [ MODEL call ] → cost.add → branch stop_reason │      │    │
            │   │   │       ▲           (black box)             │                  │      │    │
            │   │   │       └──── tool_use? run tools, loop ────┘                  │      │    │
            │   │   │            end_turn? → post-guards → return text             │      │    │
            │   │   └──────────────────────────────────────────────────────────────┘      │    │
            │   │   verify(text)  ── fail ──► inject feedback, retry                       │    │
            │   └──────────────── pass ──► done ───────────────────────────────────────────┘    │
            │        │                                                                        │
            │        ▼  flush usage (ALWAYS, even on error/abort)                              │
 ◄──────────│   response + citations                                                          │
            └─────────────────────────────────────────────────────────────────────────────────┘
```

Everything inside the box is code **you** control. The only black box is the single
`[ MODEL call ]`. The whole design is about constraining what happens before and
after that call.

---

## 1. Entry point & request lifecycle — `app/api/aegis/route.ts`

**For:** the HTTP boundary. Rate-limits, decides streaming vs JSON, owns the
usage recorder, guarantees usage is logged on every exit path.

**Key functions:** `POST()` (JSON path), `streamingResponse()` (SSE path).

```ts
// 30 calls/hour per IP-hash — a coarse abuse guardrail at the edge.
const aegisLimiter = rateLimit({ key: 'aegis', limit: 30, windowMs: 60*60*1000 });

export async function POST(req) {
  const startedAt = Date.now();
  if (!aegisLimiter.check(ipHash(req)).ok) return 429;       // ← guardrail #0
  const body = await req.json();
  const traceId = randomUUID();

  if (wantsStreaming(req)) return streamingResponse(body, traceId);  // SSE for the UI

  // The recorder owns the run's cost accumulator. Flushed in `finally`, so
  // a cost-cap kill / verify-exhaustion / crash still records what was billed.
  const recorder = new UsageRecorder(traceId, KB.version);
  try {
    const result = await runAegis(body, recorder);          // ← the agent
    return NextResponse.json({ /* text, citations, meta.cost … */ });
  } catch (err) {
    /* map AegisError.code → HTTP status */
  } finally {
    recorder.flush(Date.now() - startedAt);                 // ← ALWAYS log usage
  }
}
```

**Why:**
- **`finally` flush** is the core reliability fix: usage used to be logged only on
  the happy path, so failed/aborted runs recorded `$0` despite being billed — the
  source of a ~4× dashboard undercount. (See §9.)
- **Streaming default:** the UI sends `Accept: text/event-stream` to get token-by-token
  output; `curl`/tests get JSON. `wantsStreaming()` decides from the header.
- For streaming, the same recorder is flushed from **both** `finally` *and* the
  stream's `cancel()` callback — so a user closing the tab mid-answer is still recorded.

---

## 2. The agent entry — `lib/aegis/index.ts`

**For:** turn a validated request into a model+mode+tool plan, run the loop, shape the response.

**Key functions:** `runAegis()` (JSON), `runAegisStreaming()` (SSE generator).

```ts
export async function runAegis(input, recorder?) {
  const req = AegisRequest.parse(input);                     // ← Zod validates/normalizes
  const conversationId = req.conversationId ?? crypto.randomUUID();
  recorder?.setMeta({ conversationId, mode: req.mode, language: req.language });

  // Intent classification ONLY for CONVERSATIONAL (other modes have a fixed model).
  let complexity = 0.5;
  if (req.mode === 'CONVERSATIONAL') {
    const intent = await classifyIntent(req.message, callHaiku,
      (usage) => recorder?.cost.add(MODEL_IDS.haiku, usage)); // ← bill the helper call too
    complexity = intent.complexity;
  }
  const route = routeToModel(req.mode, complexity);          // ← pick the model
  const spec  = getModeSpec(req.mode, req.language);         // ← system prompt + tools + ceilings

  // Seed working memory: prior history (1:1) then the sanitized new user message.
  const messages = [ ...req.history, { role: 'user', content: sanitizeUserMessage(req.message) } ];

  const initialState = {
    messages, iteration: 0,
    cost: recorder?.cost ?? new CostAccumulator(),           // ← shared so errors still bill
    toolCalls: [], toolsCalled: 0, allowedIds: new Set(),    // allowedIds drives verify
  };

  try {
    const { text, state, verify } = await runOuterLoop(spec, initialState, route.model, req.language);
    const citations = [...text.matchAll(/\[(R-[A-Z0-9]+-[A-Z0-9-]+)\]/g)].map(m => m[1]); // distinct
    recorder?.setMeta({ exitReason: 'done', verifyPassed: verify.ok, citationCount: citations.length });
    return { text, citations, conversationId, modelUsed: route.model, /* … */ cost: state.cost.breakdown(), verify };
  } catch (err) {
    recorder?.setMeta({ exitReason: err instanceof AegisError ? err.code : 'internal_error' });
    throw err;
  } finally {
    recorder?.setMeta({ iterations: initialState.iteration, toolCalls: initialState.toolCalls.length });
  }
}
```

**Why:**
- **`recorder.cost` is shared** with the loop's state. Because it's the *same object*,
  the route can read accumulated cost in `finally` even when the loop throws.
- **`allowedIds`** (a `Set`) is the trust anchor for citations: only KB IDs that
  *actually came back from a tool* are allowed in the final answer (enforced in verify, §7).
- **`exitReason`** is set on every path → stored per row so the dashboard can split
  "successful spend" from "billed-but-failed spend."

---

## 3. Model selection (router) — `lib/aegis/router.ts`

**For:** decide *which* Claude model and *how hard* to think, per task.

**Key functions:** `classifyIntent()`, `routeToModel()`.

```ts
// Cheap Haiku call classifies the message → {mode, complexity 0..1}. Always falls
// back to a safe default on any parse/JSON error (never throws into the hot path).
export async function classifyIntent(message, callModel, onUsage?) {
  try {
    const { text, usage } = await callModel({ model: MODEL_IDS.haiku, prompt: …, maxTokens: 100 });
    if (usage) onUsage?.(usage);                              // ← fold cost in
    /* parse {"mode","complexity"}; validate; else FALLBACK_INTENT */
  } catch { return FALLBACK_INTENT; }
}

export function routeToModel(mode, complexity) {
  switch (mode) {
    case 'ASSESS':         return { model: SONNET, … };       // structured → Sonnet (fixed)
    case 'GAP_ANALYZE':    return { model: SONNET, … };       // document mapping → Sonnet (fixed)
    case 'CONTROL_ADVISE': return { model: OPUS,   … };       // hardest synthesis → Opus (fixed)
    case 'CONVERSATIONAL':                                    // ONLY mode that escalates:
      return complexity > 0.5 ? { model: SONNET, … }          //   complex Q → Sonnet
                              : { model: HAIKU,  … };          //   simple  Q → Haiku
  }
}
```

**Why:**
- **Structured modes use a fixed model** for *cost predictability* — an assessment
  always costs roughly the same. Only free-form chat escalates by difficulty, so
  trivial questions ("What is DORA?") stay on cheap Haiku.
- **Classifier is Haiku + fail-safe:** a wrong/failed classification degrades to
  `CONVERSATIONAL @ complexity 0.5` rather than erroring.

---

## 4. Mode spec & semantic memory — `lib/aegis/modes.ts`, `lib/aegis/prompts/*`, `lib/kb/*`

**For:** the agent's **knowledge** (what it knows) and **procedure** (how to behave per mode).

**Key function:** `getModeSpec(mode, language)`.

```ts
export function getModeSpec(mode, language) {
  return {
    systemBlocks: [
      { text: AEGIS_SYSTEM_PROMPT, cached: true },           // [0] identity — same for everyone
      { text: buildModePrompt(mode, language), cached: true },// [1] mode + language workflow
    ],
    defaultTools:  MODE_TOOLS[mode],                          // tool SUBSET per mode
    maxTokens:     MODE_MAX_TOKENS[mode],                     // 2048 (chat) … 4096 (structured)
    maxIterations: MODE_MAX_ITERATIONS[mode],                // 10 / 15 / 20 / 25
  };
}
```

The **identity prompt** ([prompts/identity.ts](../../lib/aegis/prompts/identity.ts)) is the
"constitution" — the HARD RULES that the guardrails + verify then *enforce in code*:

```
1. ONLY answer from tool results.
2. EVERY regulation claim cites [R-XXXX-NNN] — only IDs that appeared in tool results.
3. NEVER invent article numbers, fines, deadlines, authorities.
4. NEVER give legal advice.
5. Distinguish binding levels (mandatory / supervisory_expectation / best_practice).
```

**Semantic memory = the KB** ([lib/kb/index.ts](../../lib/kb/index.ts)): 265 requirements,
160 controls, 19 regulations, loaded from JSON and **Zod-validated at boot**. It is
**not** stuffed into the context window — it's reached through tools (RAG-style):

```ts
export const KB = {
  version: '2026-05-25',
  byId, byRegulation, byJurisdiction, byCategory, byBindingLevel,
  search: (q) => requirements.filter(/* title/summary/id/tags/controls match */),
};
```

**Why:**
- **Two cached system blocks, not one:** the identity block is identical fleet-wide
  (max cache reuse); the mode+language block changes per (mode, language). Fusing
  language *into* block [1] means the prompt cache hits within a language session
  instead of fragmenting. (See §8 for the cache mechanics.)
- **KB via tools, not in-context:** 265 requirements would bloat every prompt and
  degrade quality ("even 1M windows degrade when overstuffed"). Tools fetch only
  what's relevant, and — crucially — produce the `allowedIds` whitelist that makes
  citations verifiable.
- **Per-mode tool subsets:** `CONTROL_ADVISE` doesn't get `analyze_document`; fewer
  tools = less room to go wrong.

> ⚠️ **Gotcha worth noting:** `MODE_MAX_ITERATIONS` allows up to 25 (GAP_ANALYZE),
> but the pre-guard kills at `DEFAULT_GUARDRAILS.maxIterations = 10` (§6) and is
> checked first — so **10 is the effective ceiling today** for all modes. If you
> want the higher per-mode ceilings to matter, the guardrail config needs to read
> the per-mode value.

---

## 5. Tool registry — `lib/aegis/tools/index.ts`

**For:** the agent's **hands** — the only way it touches the KB or documents.

**Key function:** `createToolRegistry(subset?)` → `{ schemas, execute }`.

```ts
export function createToolRegistry(subset?) {
  const names   = subset ?? ALL_TOOL_NAMES;                  // mode passes its subset
  const schemas = names.map(n => SCHEMA_BY_NAME[n]);         // → Anthropic Tool[]

  return {
    schemas,                                                 // sent to messages.create
    async execute(call) {                                    // runs one tool_use block
      try {
        const { content, isError } = dispatch(call.name, call.input);
        return { tool_use_id: call.id, content: JSON.stringify(content), is_error: isError };
      } catch (err) {
        // A throwing tool becomes a structured tool_result error, NOT a crash —
        // the model sees the error and can recover.
        return { tool_use_id: call.id, content: JSON.stringify({ status:'error', … }), is_error: true };
      }
    },
  };
}
```

The 6 tools: `search_kb`, `get_crosswalk`, `read_source` (raw legislation fallback),
`analyze_document`, `fill_template`, `generate_report` (Phase-1 placeholder → returns
`is_error:true` so the model summarizes inline instead).

**Why:**
- **Uniform contract** (`schema` + `execute → ToolResult`) means the loop never
  special-cases a tool; adding a tool is "register schema + executor."
- **Errors are data, not exceptions:** a failed tool returns `is_error:true` content,
  keeping the loop alive and letting the model self-correct.
- **Fresh registry per request:** trivial isolation for tests; schemas are immutable.

---

## 6. The agent loop — `lib/aegis/loop.ts`

**For:** the perceive→act→observe cycle, wrapped in a verify-retry envelope.

**Key functions:** `runInnerLoop()` (tool cycle), `runOuterLoop()` (verify retries).
Streaming twins: `runInnerLoopStreaming()`, `runOuterLoopStreaming()`.

### Inner loop — one model turn + tool execution

```ts
while (state.iteration < spec.maxIterations) {
  // 1. PRE-GUARDS (§6.1): may kill (iteration/cost), compress, or sanitize.
  const pre = applyGuardrails('pre', DEFAULT_GUARDRAILS, preState);
  if (pre.action === 'kill') throw new AegisError(pre.code, pre.detail);
  if (pre.action === 'compress') state.messages = await compressContext(state.messages, 4, callHaiku, …);

  // 2. THE MODEL CALL (the black box).
  const response = await callClaude({ model, systemBlocks: spec.systemBlocks, tools, messages, maxTokens });

  // 3. ACCOUNTING: raw usage straight through → prices every bucket (§9).
  state.cost.add(model, response.usage);

  // 4. OBSERVE → branch on why the model stopped.
  if (response.stop_reason === 'tool_use') {
    state.messages.push({ role:'assistant', content: projectAssistantContent(response.content) });
    for (const block of response.content) if (block.type === 'tool_use') {
      const result = await registry.execute({ id: block.id, name: block.name, input: block.input });
      toolResults.push(result);
      for (const id of extractKbIds(result.content)) state.allowedIds.add(id); // ← grow the whitelist
    }
    state.messages.push({ role:'user', content: toolResults });
    state.iteration++; continue;                              // loop again
  }

  if (response.stop_reason === 'end_turn' || 'max_tokens') {
    // 5. POST-GUARDS (§6.1): strip banned phrases / soft citation warnings.
    const post = applyGuardrails('post', DEFAULT_GUARDRAILS, { responseText: rawText, citations: [] });
    if (post.action === 'fail') throw new AegisError('verify_failed', post.reason); // retryable
    return post.text ?? rawText;
  }
}
throw new AegisError('iteration_limit', …);                   // ran out of iterations
```

### Outer loop — verify and retry with feedback

```ts
for (let attempt = 1; attempt <= maxAttempts /* =3 */; attempt++) {
  let text;
  try { text = await runInnerLoop(spec, state, model, language); }
  catch (err) {
    // A soft verify failure becomes a retry WITH feedback; hard errors propagate.
    if (err.code === 'verify_failed' && attempt < maxAttempts) {
      state.messages.push({ role:'user', content:`[VERIFY FEEDBACK — please correct] ${err.message}…` });
      continue;
    }
    throw err;                                                // cost_limit / iteration_limit / upstream → out
  }

  const verify = verifyResponse({ text, allowedIds: state.allowedIds, toolsCalled, … }); // §7
  if (verify.ok) return { text, state, verify };              // success

  if (attempt < maxAttempts) {                                // failed → feed the reason back and retry
    state.messages.push({ role:'user', content:`[VERIFY FEEDBACK — please correct] ${verify.reason}\n${verify.feedback}` });
  }
}
throw new AegisError('verify_failed', …);                     // exhausted retries
```

**Why:**
- **Two loops, two jobs.** Inner = "use tools until you have an answer." Outer =
  "is the answer actually good? if not, tell the model *why* and try again."
- **Verify feedback is injected as a user message**, so the model gets a concrete,
  machine-derived correction ("you cited an ID no tool returned") rather than a vague retry.
- **`allowedIds` grows from tool results**, turn by turn — it's the runtime evidence
  that verify checks citations against.
- **Hard vs soft failures:** `cost_limit`/`iteration_limit`/`upstream_error` propagate
  (stop the run); only empty/verify failures retry. Bounded by `maxAttempts = 3`.

### 6.1 Guardrails — `lib/aegis/guardrails/{pre,post}.ts`

**For:** deterministic limits & content rules around the model call.

**Pre-guards** (order matters — cheapest kill first):

| # | Check | Threshold | Action |
|---|-------|-----------|--------|
| 1 | iteration limit | `maxIterations: 10` | `kill` → `iteration_limit` |
| 2 | cost cap | `maxCostUsd: 10.0` | `kill` → `cost_limit` |
| 3 | context overflow | `> 20` messages | `compress` (§8) |
| 4 | prompt-injection patterns | `bannedInputPatterns` | `sanitize` (redact + strip HTML) |

```ts
if (state.iteration >= config.maxIterations) return { action:'kill', code:'iteration_limit', … };
if (state.costUsd   >  config.maxCostUsd)    return { action:'kill', code:'cost_limit', … };   // ← budget kill-switch
if (state.conversationLength > config.maxConversationLength) return { action:'compress', … };
// e.g. /ignore previous instructions/i → replaced with [redacted], then HTML-stripped
```

**Post-guards:**

```ts
if (responseText.trim().length < minResponseLength /*10*/) return { action:'fail', … }; // empty → retry
// strip whole sentences containing banned phrases ("Rechtsberatung", "legal advice", …)
// soft WARN if a paragraph cites an article (Art./§/Rz./Kap.) without a [R-...] ID
```

**Why:** these are the IBM "guardrails" — **deterministic** budget/step kill-switches
and content rules that don't depend on the model behaving. The cost cap is the literal
"don't let it run away with my money" switch.

---

## 7. Verify — `lib/aegis/verify.ts`

**For:** prove the finished answer is trustworthy — **deterministic, no LLM**.

**Key function:** `verifyResponse(input)` → runs 5 checks, returns the **first** failure.

| Check | What it catches |
|-------|-----------------|
| `non_empty_response` | < 10 chars — non-answers |
| `citation_coverage` | an article ref (`Art.`/`§`) in a paragraph with **no** `[R-...]`; or a cited ID **not** in `allowedIds` (i.e. not from a tool) |
| `no_hallucinated_regulations` | a regulation name not in the KB whitelist (with German-compound handling, e.g. `FINMA-Standards`) |
| `language_consistency` | answer drifts to the wrong language (DE/EN marker counting) |
| `no_false_ignorance` | model says "not in the KB" **after** issuing tool calls — and especially if it never tried the `read_source` fallback |

```ts
// citation_coverage — the trust anchor: every cited ID must have come from a tool.
for (const cit of idMatches) {
  const id = cit.slice(1, -1);
  if (!allowedIds.has(id))                                    // ← was it actually returned by a tool?
    return fail('citation_coverage', `Cited ID "${id}" was never returned by a tool call.`, …);
}

// no_false_ignorance — TRACE inspection, not text trust:
if (toolsCalled > 0 && claimsIgnorance) {
  if (!toolsCalledNames.includes('read_source'))             // ← did it try the fallback?
    return fail('no_false_ignorance', 'Claimed ignorance but never called read_source.', …);
}
```

**Why:** this is the IBM demo's core lesson — **don't trust the model's word, inspect
the trace.** `no_false_ignorance` literally checks the tool-call history to catch the
model lying ("I can't find it") when it never actually looked. Being pure code, it's
safe to run on every response and can't itself hallucinate.

---

## 8. Context management — `lib/aegis/context/compress.ts` + caching in `client.ts`

**For:** keep the working-memory window healthy and cheap.

**Compression** (`compressContext`) — triggered by pre-guard #3 at > 20 messages:

```ts
// Keep the ends, summarize the middle. Anchors preserve topic + recent turns.
const head = messages.slice(0, 2);                            // initial topic-setting pair
const tail = messages.slice(-keepLast /*4*/);                 // recent context
const summary = await callHaiku(`Summarize…preserve every R-XXXX-NNN id…`, middle);
return [ ...head, { role:'user', content:`<<COMPRESSED HISTORY>>\n${summary}` }, ...tail ];
// If Haiku fails or summary is suspiciously short → hard-truncate (drop middle) and continue.
```

**Prompt caching** (`client.ts`) — the cost lever:

```ts
// Cache breakpoint on the LAST system block flagged cached → identity+mode are a
// cached prefix; cache READ is ~10% the price of fresh input.
if (i === lastCachedIdx) param.cache_control = { type:'ephemeral' };
// Same for the tool list — mark the last tool so the whole tool schema is cached.
```

**Why:**
- **Summarize-the-middle** keeps the parts that matter (opening intent + latest turns)
  and compresses the rest, while *explicitly preserving requirement IDs* so citations
  survive compaction. Graceful fallback to truncation means compaction can never break the run.
- **Caching is why the system prompt (identity + KB rules + mode workflow) is "free"
  after the first call** — it's billed at the cache-read rate. This is also why the
  blocks are ordered identity→mode (stable prefix first).

### 8.1 Verifying the cache breakpoint (manual, billed)

The conversation history also carries a **rolling** cache breakpoint (a 5-minute
`ephemeral` mark on the last block of the last message, rolled forward each call —
`withMessageCacheBreakpoint` in `client.ts`). Unit tests prove the breakpoint *lands*
on the right block, but they **cannot** prove the bill actually moves — whether a hit
occurs is a property of the **live Anthropic API**, not of our code, so it isn't
unit-testable.

**What to check:** that the rolling breakpoint produces real cache hits across
inner-loop iterations — i.e. each call reads the prior prefix from cache instead of
re-paying full input price.

**How:**

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/verify-cache-hit.ts --confirm
```

- **PASS** — call #2 reports `cache_read_input_tokens > 0` **and** lower fresh
  `input_tokens` than call #1 (same answer, cheaper bill).
- **FAIL** — call #2 reports `cache_read_input_tokens == 0`: the breakpoint is placed
  but not hitting (e.g. prefix under the model's cache minimum, or calls >5 min apart).
  That's a bug to fix **before** merging the breakpoint change, not after.

> **The script is intentionally local / gitignored** (`scripts/` is ignored repo-wide).
> It makes **real, billed** Anthropic calls and needs an API key, so it does not belong
> in version control or CI. It is also guarded (`--confirm` / `RUN_BILLED=1`) so it can't
> fire by accident, and sits outside the vitest glob so it never runs automatically.
>
> **If lost, recreate it as:** a small `tsx` script that calls `callClaude` twice with
> the same `ASSESS` system blocks + tools — first with one user turn, then append-only
> with an assistant turn plus a follow-up question — and prints `response.usage` for
> each, asserting call #2's `cache_read_input_tokens > 0`.

---

## 9. Cost & usage accounting — `context/cost.ts`, `usage-recorder.ts`, `usage-logger.ts`

**For:** know *exactly* what each run cost and make logging failures observable.
(This is the layer we recently hardened.)

```ts
// computeCost prices EVERY bucket the API bills, at verified rates. Throws on an
// unknown model — never silently returns 0 (which would hide spend).
export function computeCost(model, usage) {
  const p = MODEL_COSTS[model]; if (!p) throw new Error(`no pricing for "${model}"`);
  return ( usage.input_tokens            * p.input
         + usage.output_tokens           * p.output
         + usage.cache_read_input_tokens * p.cacheRead
         + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h ) / 1e6 * 100; // cents
}
```

```ts
// UsageRecorder owns the run's accumulator + meta; flush() writes ONE row, idempotently,
// and is a no-op if no call was billed. Called from route's finally/cancel.
flush(latencyMs) {
  if (this.logged || !this.hasUsage()) return;
  this.logged = true;
  logUsage({ …bd, costCents: bd.usd*100, pricingVersion: PRICING_VERSION, exitReason: this.meta.exitReason, … });
}
```

```ts
// logUsage stays fail-safe (never throws) but is now OBSERVABLE: DB error / Zod reject
// emit a structured event you can alert on.
catch (err) { reportUsageLogFailure('aegis_usage_log_failed', record, err.message); }
```

**Why:**
- **Raw usage passed through unmodified** → cache buckets are priced (they used to be
  dropped, undercounting ~4×).
- **Record on all exit paths** (recorder shared with the loop, flushed in `finally`) →
  cost-capped / errored / aborted runs are billed correctly, not logged as `$0`.
- **`exitReason` + raw token columns persisted** → the dashboard can separate failed
  from successful spend, and a future rate change can be recomputed from stored tokens.
- **Loud failures** → a forgotten `prisma db push` surfaces as `aegis_usage_log_failed`
  instead of silently reverting to logging nothing.

---

## 10. Streaming vs JSON

Two parallel implementations share all the logic above; the streaming ones additionally
`yield` SSE events (`token`, `status`, `tool_result`, `thinking_clear`, `replace_text`,
`verify_retry`, terminal `done`/`error`). The route turns those into `event: …\ndata: …`.
`thinking_clear` tells the UI to discard pre-tool reasoning text once a `tool_use` block
starts mid-stream. Usage is recorded the same way (shared recorder, flushed in `finally`/`cancel`).

---

## 11. CoALA memory map

| CoALA type | In AEGIS | Where |
|------------|----------|-------|
| **Working** (now) | `messages` array per run; compacted at >20 | `index.ts`, `compress.ts` |
| **Semantic** (knowledge) | the KB (265 reqs) via tools + identity/mode prompts | `lib/kb/*`, `prompts/*` |
| **Procedural** (how-to) | 4 modes = workflows + tool subsets + ceilings | `modes.ts`, `prompts/mode_*` |
| **Episodic** (learned) | **absent** — usage is logged but never read back into prompts | — |

> Episodic is the open gap: nothing distilled from past conversations is fed back into
> future ones. Candidate next step — persist a per-`conversationId` distilled record
> (cited IDs, verify failures, topics) and inject it on resume.

---

## 12. Design decisions at a glance — *what & why*

| Decision | Why |
|----------|-----|
| Fixed model per structured mode; escalate only in chat | cost predictability; cheap model for trivial Q&A |
| KB via tools, not in-context | avoids window bloat; produces the `allowedIds` citation whitelist |
| Verify is deterministic code, no LLM | can't hallucinate; safe in the hot path; inspects the trace |
| `allowedIds` from tool results | makes "every claim is cited from a real source" *enforceable* |
| Two cached system blocks (identity, mode+lang) | maximize prompt-cache reuse; language-session cache hits |
| Cost cap + iteration cap as `kill` | hard budget/step kill-switches independent of the model |
| Compress middle, preserve R-IDs, fallback truncate | healthy window without losing citations or breaking the run |
| Record usage on all exit paths (recorder + `finally`) | failed/aborted runs are billed reality, not `$0` |
| `computeCost` throws on unknown model | never silently under-report spend |
| Tool errors → `is_error` data, not exceptions | model can self-correct; loop stays alive |
| Verify failure → feedback injected, retry ≤3 | targeted self-correction instead of blind retry |

---

## 13. File map (where to look)

```
app/api/aegis/route.ts        HTTP boundary, rate-limit, streaming, usage flush  (§1)
lib/aegis/index.ts            runAegis / runAegisStreaming — orchestration         (§2)
lib/aegis/router.ts           classifyIntent + routeToModel                       (§3)
lib/aegis/modes.ts            getModeSpec — system blocks, tool subset, ceilings   (§4)
lib/aegis/prompts/*           identity (constitution) + per-mode workflows         (§4)
lib/kb/*                      semantic memory (regulations/requirements/crosswalk) (§4)
lib/aegis/tools/*             6 tools, registry, schema+execute contract           (§5)
lib/aegis/loop.ts             inner (tool cycle) + outer (verify-retry) loops      (§6)
lib/aegis/guardrails/*        pre/post deterministic checks                        (§6.1)
lib/aegis/verify.ts           5 deterministic answer checks                        (§7)
lib/aegis/context/compress.ts conversation compaction                             (§8)
lib/aegis/client.ts           SDK wrapper, retries, cache breakpoints              (§8)
lib/aegis/context/cost.ts     computeCost + CostAccumulator                        (§9)
lib/aegis/usage-recorder.ts   per-run accumulator + meta, flush-once               (§9)
lib/aegis/usage-logger.ts     Zod-validated, fail-safe, observable persistence     (§9)
```
