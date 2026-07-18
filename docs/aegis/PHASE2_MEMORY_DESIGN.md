# Phase 2 Design — Persistent Conversation Memory

Status: **PROPOSAL — awaiting confirmation. No code changed.**
Grounded in the code as of Phase 1 merge (all file:line references verified).

---

## 0. What the code does today (investigation summary)

**Turn assembly.** Every run is stateless. `runAegis` / `runAegisStreaming`
(`lib/aegis/index.ts:61-70, 211-217`) build the seed as
`[...req.history, sanitized user message]`. `req.history` is client-supplied
(`AegisHistoryMessage = {role, content, citedIds?}`, max 40 — `types.ts:90-102`)
and the UI currently sends none. Mode → tools/limits via `getModeSpec`
(`modes.ts:59`); routing (Haiku/Sonnet/Opus) happens before the loop in
`index.ts:44-51` and is identical for all modes from the seed's perspective.

**Intra-turn message growth.** The inner loop appends
`assistant(tool_use[])` + `user(tool_result[])` pairs (`loop.ts:209-239`).
The API hard-rejects a `tool_result` without its matching `tool_use` in the
immediately preceding assistant turn — this is why `trimForRetry`
(`loop.ts:123-139`) rebuilds retries from the **text-only seed** and folds tool
evidence in as plain text, never as raw blocks.

**Compaction.** Pre-guard fires when the *last* prompt exceeded 40K tokens
(`guardrails/pre.ts:43`, measured from real API usage via
`cost.ts:152-156`); `compressContext` keeps first 2 + last 4 messages and
replaces the middle with a ≤300-token Haiku summary (`compress.ts:35-75`).
Note: it can only fire **after** the first call of a run — an oversized seed
goes out at full price once.

**Cache.** `client.ts` recomputes three `ephemeral` (5-min TTL) breakpoints on
every call: last cached system block, last tool, last content block of the last
message (`client.ts:67-144`). Cache hits therefore require a byte-identical,
append-only prefix — nothing is stored between calls.

**Phase 1 SSE path.** `streamingResponse` (`app/api/aegis/route.ts`) races each
generator pull against a 270s deadline, guards every enqueue, and guarantees a
terminal `done`/`error` event in `finally`. The `done` event's
`meta.toolCalls` carries only 200-char `resultPreview`s — **full tool results
exist only in the run's in-memory `state.messages`**. Any full-fidelity
persistence must capture from state, not from the event.

**Sessions & ownership.** `lib/session.ts` verifies the signed `rc_session`
cookie; `AegisDocument` scopes every read with
`where: { id, sessionId, expiresAt: { gt: now } }` (field is **`sessionId`**,
not `ownerSessionId`). 404 for wrong-session and nonexistent ids is
indistinguishable. Memory must mirror this exactly.

**Telemetry.** One `AegisUsageLog` row per run, written by
`UsageRecorder.flush()` from the route's `finally` *and* the stream's
`cancel()`; idempotent (`logged` guard), no-op if no Claude call happened,
`exitReason` defaults to `aborted` so cancelled streams are labeled correctly
(`usage-recorder.ts:75-105`). **The usage row contains no message content** —
only counts, ids, flags. This matters for erasure (§4).

---

## 1. Persistence model & schema

### Options
- **A. Two tables, text-first messages + JSON audit sidecar** (recommended).
  `AegisConversation` + `AegisMessage`; each message stores the final text as a
  first-class column and the turn's tool activity as a non-replayed JSON blob.
- **B. Raw-block persistence.** Store the full Anthropic
  `MessageParam[]` (every tool_use/tool_result block) per turn and replay
  verbatim on resume.
- **C. Single JSON document per conversation.** One row, whole transcript as
  JSON.

### Recommendation: A

```prisma
model AegisConversation {
  id         String   @id @default(uuid())
  sessionId  String              // owner — same pattern/name as AegisDocument
  userId     String?             // null until real auth lands (migration: backfill once a
                                 // session→user link exists; reads switch to OR(userId, sessionId))
  mode       String              // mode of the first turn (turns may override per-message)
  language   String   @default("de")
  title      String?             // deterministic: first user message, truncated to ~80 chars
  createdAt  DateTime @default(now())
  lastTurnAt DateTime @default(now())
  expiresAt  DateTime            // retention horizon, refreshed on each turn (§4)

  messages   AegisMessage[]

  @@index([sessionId, lastTurnAt])
  @@index([expiresAt])
}

model AegisMessage {
  id             String   @id @default(cuid())
  conversationId String
  conversation   AegisConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  seq            Int                 // dense, server-assigned ordering
  role           String              // "user" | "assistant"
  content        String              // sanitized user input / final assistant text
  citedIds       String[] @default([])
  status         String   @default("complete") // "complete" | "failed"
  exitReason     String?             // done | verify_failed | timeout | cost_limit | … (assistant rows)
  model          String?             // routed model for this turn (assistant rows)
  toolCalls      Json?               // audit sidecar: [{name, input, result, isError}] — full
                                     // results captured from state.messages, NEVER replayed
  traceId        String?             // join key to AegisUsageLog (cost source of truth)
  createdAt      DateTime @default(now())

  @@unique([conversationId, seq])
  @@index([conversationId, seq])
}
```

**Trade-offs.** A keeps the replayed context identical in shape to today's
`AegisHistoryMessage` (zero new failure modes in the loop), keeps full tool
activity for display/audit, and cascading delete makes erasure one statement.
B maximizes fidelity but replaying weeks-old tool scaffolding balloons every
prompt, breaks the 40K budget fast, and reintroduces the orphaned-`tool_result`
class of bugs trimForRetry exists to prevent. C makes seq-scans, partial loads,
and per-message erasure/inspection awkward and rewrites a growing blob each
turn.

Token counts and cost stay in `AegisUsageLog` (joined via `traceId`) — no
duplicated cost columns to drift out of sync.

## 2. Tool-call fidelity on reload

**Options:** (a) replay raw tool_use/tool_result blocks; (b) replay text-only
turns, persist tool activity as the JSON sidecar; (c) text-only turns with each
turn's `citedIds` attached, sidecar for audit.

**Recommendation: (c).** The resume seed is exactly what `trimForRetry`
already proved safe: alternating `{role, content: string}` turns. No
`tool_result` can ever be orphaned because none is ever replayed. The
assistant's citations (`[R-…]` ids, already extracted per turn at
`index.ts:93-99`) ride along as `citedIds`; if a follow-up needs the evidence
behind an old citation, the model re-fetches via `search_kb` — same recovery
path the verify-retry flow uses today. The sidecar JSON preserves the full
record for the UI/audit without ever entering a prompt.

**Trade-off:** a follow-up question may re-spend 1–2 tool iterations re-fetching
KB entries the previous turn already saw. That's cents, deterministic, and far
cheaper than carrying every turn's tool payloads in every future prompt.

## 3. Compaction & cache on resume

**Options:** (a) persist full transcript, derive the seed at request time;
(b) maintain a persisted rolling summary updated after each turn.

**Recommendation: (a), strictly.** The constraint "no LLM in storage/retrieval"
rules out (b)'s summary generation at write time anyway. Resume flow:

1. Load messages `WHERE conversationId AND sessionId` ordered by `seq`,
   newest-first accumulation under a **deterministic seed budget**:
   `floor(chars/4) ≤ 24K tokens` (leaves headroom under `maxContextTokens` 40K
   for tools + generation), max 40 turns (existing Zod cap).
2. Build the seed oldest→newest (anchor turns first — same shape compaction
   expects: first 2 are the topic anchor).
3. If the *estimated* seed still exceeds the budget mid-conversation-resume,
   run the existing `compressContext` **before the first call** (closing the
   known "compaction can't fire on call 1" gap — this is the one place an LLM
   call participates, and it's request-time inside the billed run, not storage).
4. The full transcript in Postgres remains the authoritative record; whatever
   compaction does to the in-flight context never writes back.

**Cache breakpoints:** nothing new is needed — `client.ts` recomputes
placement per call. What we must guarantee is **byte-stable seed
serialization**: same rows → same strings → same prefix. Concretely: order by
`seq` only, no timestamps/ids injected into content, sanitization applied once
at write time (store the sanitized form), selection cutoffs computed from
persisted values only. Then turn N+1 within a 5-minute window cache-reads the
entire turn-N prefix exactly as the inner loop does today. A resume hours later
is a cold cache by TTL — unavoidable, costs one cache-write, nothing to design
around. (A later 1h-TTL breakpoint is already priced in `splitCacheWrites` —
out of scope here.)

## 4. Retention & erasure (GDPR / revDSG) — decision surfaced, not silent

Conversation content can contain client regulatory specifics → treat all of
`AegisMessage.content` + `toolCalls` as personal data.

**Retention policy (proposed):** conversations expire **90 days after
`lastTurnAt`** (refreshed per turn); a daily-equivalent lazy sweep (same
pattern as `AegisDocument` cleanup: opportunistic `deleteMany` on write)
hard-deletes expired conversations. No soft-delete state.

**Erasure path (proposed):** `DELETE /api/aegis/conversations/[id]` (session-
scoped, 404 on wrong session) and `DELETE /api/aegis/conversations` (wipe my
session). One `delete` on the conversation cascades to all messages, including
the `toolCalls` sidecars. There are no other derived stores: compaction
summaries are in-flight only (§3), and `AegisDocument` already has its own
1h TTL.

**The tension you asked me not to bury:** `AegisUsageLog` is the audit/cost
record and keeps `conversationId` forever. After erasure that row still exists.
Two readings:

- **Keep usage rows untouched (recommended).** They contain *no content* —
  tokens, costs, mode, flags, and a `conversationId` that, post-erasure,
  references nothing. Legitimate-interest basis (billing/audit/abuse), and the
  identifier is pseudonymous with its link destroyed. This preserves the
  hard-won "every exit path is cost-tracked" property with zero regression.
- **Stricter alternative:** on erasure, additionally null or hash
  `conversationId` (and `traceId` linkage) in `AegisUsageLog`. Maximally
  conservative, but breaks the dashboard's per-conversation aggregation and
  any future billing reconciliation, for little real privacy gain.

**My recommendation is the first option**, with the erasure endpoint's response
explicitly stating that anonymous usage statistics (token counts, costs — no
content) are retained. **This is the one decision I want your explicit sign-off
on**, since it's a legal-posture call, not an engineering one.

## 5. Persistence timing & failure modes

**Where writes happen (streaming path, the UI default):**

| Moment | Write |
|---|---|
| Run start, after Zod parse + conversation ownership check | Upsert conversation (create on first turn) + insert the **user** message (`status: complete`). The user's words are theirs; they persist even if the run then dies. |
| Terminal `done` (inside the existing `finally`-guaranteed path) | Insert **assistant** message: final text, citedIds, model, `exitReason: done`, toolCalls sidecar captured from `state.toolCalls`/`state.messages`. |
| Terminal `error` / 270s timeout / `cancel()` | Insert **assistant** message with `status: failed`, the `exitReason` (`timeout`, `cost_limit`, `verify_failed`, `aborted`, …), empty-or-partial text. Mirrors the usage-log philosophy: failed spend is still history. |

Implementation note: this slots into `streamingResponse`'s existing `finally`
(`route.ts`) right next to `recorder.flush()` — the same place Phase 1 already
guaranteed runs exactly once on every exit path. The non-streaming JSON branch
gets the same writes in its `try/catch/finally`.

**DB write fails mid-stream → fail-open (recommended).** The answer has already
been streamed; failing the turn because bookkeeping failed punishes the user
twice. Pattern copied from `logUsage`: swallow, log a structured
`aegis_memory_write_failed` event, and set `persisted: false` on the `done`
event's meta so the UI can show "Antwort konnte nicht gespeichert werden."
Fail-closed is wrong here for the same reason the rate limiter fails open: the
product shouldn't go down with its database. (The *user-message* write at run
start also fails open — the run proceeds stateless for that turn.)

## 6. Cost telemetry — no regression

`UsageRecorder.flush()` keeps running from the route `finally` and stream
`cancel()` exactly as today; memory writes are **additive and independent**
(separate try/catch, never share a code path that could throw before `flush`).
`AegisMessage.traceId` joins each assistant turn to its usage row, which
upgrades the dashboard (per-conversation cost becomes a join instead of a
groupBy on the client-generated conversationId) without touching the write
path. The recorder's `conversationId` meta is now the *server-validated* id —
same column, better data. All-exits coverage is unchanged because nothing about
when/whether `flush()` runs changes.

## Resume flow (end to end)

```
Client                         Server
──────                         ──────
POST /api/aegis
 {conversationId?, mode,        1. readSessionId(cookie) — as Phase 1
  message, language}            2. conversationId present?
                                   → load WHERE {id, sessionId} (404 on miss/foreign)
                                   → seed = last-N text turns under 24K-token budget
                                   conversationId absent?
                                   → create conversation (owner = sessionId)
                                3. insert user message (fail-open)
                                4. seed over budget? compressContext() pre-flight
                                5. run loop (unchanged: routing, guards, verify,
                                   rolling cache breakpoints)
 SSE: …events…                  6. terminal done/error (270s deadline intact)
 done {…, conversationId,       7. finally: recorder.flush() + insert assistant
       persisted: true}            message (fail-open) — both idempotent/guarded
```

`req.history` (client-supplied) stays for backward compatibility but is
**ignored whenever a valid `conversationId` resolves** — the server transcript
is authoritative. The UI then drops its plan to send history (Phase 2.1 of the
old plan is superseded by this design) and instead persists `conversationId`
and renders from `GET /api/aegis/conversations/[id]`.

New routes: `GET /api/aegis/conversations` (list, session-scoped),
`GET /api/aegis/conversations/[id]` (transcript), `DELETE` both (§4). German
UI strings; ids/enums stay English.

## Open questions for you

1. **Erasure vs audit (§4):** keep content-free `AegisUsageLog` rows after
   conversation erasure (my recommendation), or scrub `conversationId` there
   too? Needs your sign-off, ideally with whoever owns the deployment's privacy
   posture.
2. **Retention window:** is 90 days inactivity right for your pilot users, or
   do you want shorter (30) for the demo phase?
3. **Cross-mode conversations:** today the UI lets users switch mode mid-chat.
   Proposal stores mode per assistant message and keeps one conversation. OK,
   or should a mode switch start a new conversation?
4. **Seed budget 24K:** comfortable default (leaves 16K for tools/output under
   the 40K compaction trigger). Any reason to make it mode-specific now?
5. **Environment note:** the gate says `nvm use 22`, but this machine has only
   Node 24 (installed during Phase 1 setup; nvm default). Should I install 22,
   or is `nvm use default` acceptable for the gate?

**Stopping here as requested — no implementation until you confirm.**
