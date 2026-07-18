# RegCompass — Implementation Plan

Compiled from the full code review on 2026-06-12. Ordered by priority: each phase
is independently shippable, and later phases assume earlier ones are done.
File references point at the code as of commit `daa3b11`.

---

## Phase 1 — Production blockers (security & state)

These stand between the current code and a safe public deployment on Vercel.

### 1.1 Persist uploaded documents
**Problem:** `lib/aegis/document-store.ts` is a module-scope `Map` — every
serverless cold start / second instance loses all uploads mid-session.
**Fix:** Move to Postgres. New Prisma model `AegisDocument` (id, filename, type,
textContent, excelData JSON, excelBuffer `Bytes`, sessionId, uploadedAt,
expiresAt). Replace `storeDocument/getDocument/deleteDocument` with async DB
calls; add a cleanup of expired rows (on-read check + occasional sweep).
Callers to update: `app/api/aegis/upload/route.ts`,
`app/api/aegis/download/[id]/route.ts`, `lib/aegis/tools/analyze_document.ts`,
`fill_template.ts`.
**Acceptance:** upload → restart dev server → analyze + download still work.

### 1.2 Durable rate limiting
**Problem:** `lib/rate-limit.ts` is in-memory; N instances ⇒ N× the limit.
**Fix:** Back the sliding window with Postgres (single `RateLimitBucket` table,
`UPSERT ... RETURNING count`) or Upstash Redis if added later. Keep the current
API (`rateLimit({key, limit, windowMs}).check(id)`) so routes don't change.
**Acceptance:** limit holds across two concurrently running dev servers.

### 1.3 Session-scoped access (auth-lite) + IDOR fix
**Problem:** No authentication anywhere; `app/api/aegis/download/[id]/route.ts`
returns any document to anyone holding its UUID.
**Fix (minimal viable):** issue an httpOnly signed session cookie on first visit
(middleware), store `sessionId` on uploaded documents (1.1), and check ownership
in download/analyze/fill paths. Rate-limit by sessionId+IP. Full login (e.g.
NextAuth) is a separate later decision — this phase only establishes ownership.
**Acceptance:** downloading another session's document returns 404.

### 1.4 Upload hardening
- Magic-byte validation before parsing (`%PDF`, `PK\x03\x04` for docx/xlsx) in
  `app/api/aegis/upload/route.ts`; reject on mismatch with the extension.
- Replace `xlsx@0.18.5` (known unpatched CVEs: prototype pollution, ReDoS) with
  `exceljs`, adapting `lib/aegis/parsers/` + `excel-writer.ts`.

### 1.5 Streaming robustness
**Problem:** no overall deadline; error events not guaranteed; client can hang.
**Fix:** wrap the SSE loop in `app/api/aegis/route.ts` with an `AbortSignal.timeout`
(e.g. 120s conversational / 280s gap-analysis, below the Vercel function cap);
try/catch around every `controller.enqueue`; always emit a final `error` or
`done` event in a `finally`. Client (`lib/aegis/client-store.ts`): add an idle
timeout that surfaces a retryable error instead of spinning forever.
**Acceptance:** killing the network mid-stream shows an error bubble within
seconds; no permanently stuck "generating" state.

### 1.6 Error hygiene
Generic client-facing messages for Anthropic 400s and internal errors
(`lib/aegis/client.ts:168`, route handler catch); full detail only in server
logs.

---

## Phase 2 — Conversation memory (wire it up end-to-end)

The server supports history; the client never sends it. Until fixed, Aegis is
stateless behind a chat UI.

### 2.1 Send history + conversationId from the client
In `lib/aegis/client-store.ts` `sendMessage` (line ~433): include
`history: state.messages.filter(ok).map(m => ({role, content}))` (user/aegis →
user/assistant) and a per-session `conversationId` kept in the store. Cap at the
last N messages client-side.

### 2.2 Bound the seed history server-side
- Per-entry length cap on `AegisHistoryMessage.content` (`lib/aegis/types.ts:92`),
  e.g. `.max(16_000)`.
- Pre-flight estimate (chars/4) in `runAegis` before the first model call; if
  the seed exceeds `maxContextTokens`, run `compressContext` on it up front —
  today compaction can only trigger *after* the first (expensive) call.

### 2.3 Compaction keeps recent evidence
`lib/aegis/context/compress.ts`: keep the most recent tool_result batch intact
alongside the Haiku summary (currently all middle tool results are reduced to
200-char previews, forcing re-retrieval).

**Acceptance:** ask a question, then "explain the second point more simply" —
the answer references the prior turn without re-searching from scratch.

---

## Phase 3 — Harness efficiency (cost & latency)

### 3.1 Graceful degradation instead of hard kills
`lib/aegis/loop.ts`: when `iteration === maxIterations - 1` or cost is within
~20% of the cap, inject a user turn "Answer now with what you have; no more
tools" and call with `tool_choice: {type: 'none'}`. Only throw if even that
fails. Applies to both streaming and non-streaming loops.
**Why:** today a 25-iteration GAP_ANALYZE that hits the ceiling discards 100%
of its spend.

### 3.2 Tiered verification
`lib/aegis/verify.ts` / `loop.ts`: classify checks as hard
(`citation_coverage`, `no_hallucinated_regulations`, `non_empty_response`) vs
soft (`language_consistency`, `no_false_ignorance`). Hard fail → retry (as now).
Soft fail on the final attempt → return the answer with a `warnings` field
instead of throwing `verify_failed`.

### 3.3 Handle max_tokens truncation explicitly
`loop.ts:243`: on `stop_reason === 'max_tokens'`, continue the turn (send the
partial text back with a "continue" user turn) once, instead of letting a
truncated answer fail verify and burn a full retry.

### 3.4 Cheapen / parallelize intent classification
`lib/aegis/router.ts`: replace the blocking Haiku `classifyIntent` for
CONVERSATIONAL with a heuristic (length, '?' count, regulation-name count,
cross-regulation keywords) → complexity score. Keep the Haiku path behind a
flag for comparison. Removes ~300–500ms first-token latency on every chat turn.
Drop the unused `mode` field from the classifier prompt if the LLM path stays.

### 3.5 Reduce body-fetch iterations
`lib/aegis/tools/search_kb.ts`: add `include_body: boolean` (default false) and
include the body for the top 2–3 hits when set; or add `get_requirements(ids[])`
batch tool. Saves one full API round trip per deep-dive.

### 3.6 Retry/cache interplay
`lib/aegis/client.ts`: add 529 (`overloaded_error`) to `shouldRetry`; set
`maxRetries: 0` on the SDK client so the custom retry policy is authoritative
(today both layers retry). Keep retry seed prefix byte-identical across verify
retries (build `[...seed, failedAnswer, evidence]` once; vary only the feedback
message) so attempts 2–3 share a cache prefix.

### 3.7 Tool list & prompt hygiene
- Don't advertise placeholder tools (`generate_report`, parts of
  `fill_template`/`analyze_document` until 1.1 lands) in `MODE_TOOLS`
  (`lib/aegis/modes.ts:26`) — the model wastes iterations calling stubs.
- Add a compact KB table-of-contents (regulations × categories × counts) to the
  cached identity block (`lib/aegis/prompts/identity.ts`) so the model filters
  instead of guessing.
- Validate `voice: true` limits server-side or accept the (bounded) abuse risk
  consciously.

---

## Phase 4 — Voice (DE/EN + recognition fixes)

### 4.1 Language setting
Add `language: 'de' | 'en'` to the client store with a toggle in
`AegisChatPanel`. Thread it into:
- request body (`client-store.ts:436`, currently hardcoded `'de'`),
- `rec.lang` (`components/AegisVoiceButton.tsx:315`, hardcoded `'de-DE'` — this
  is why English recognition fails),
- TTS voice pick + `utterance.lang` (`components/AegisTtsButton.tsx:127`),
- mic hint texts (translate the German-only guidance).

### 4.2 Fix dropped speech tail
`AegisVoiceButton.tsx` `stopRecording`: don't send immediately — set a
`sendPending` flag, let `onend` merge late-arriving final results (and the last
interim if no final follows), then send. Removes the loss of the last ~1–2s of
speech.

### 4.3 Minor
`stripForSpeech` table filter: drop pipe-rows line-wise, not block-wise.

---

## Phase 5 — Library: Kindle experience

### 5.1 Position & deep links
- URL state: `/library?law=GDPR&node=art-22`; update on TOC click and (throttled)
  on scroll-spy change; restore on load. Browser back/forward works.
- localStorage: `fontSize`, sidebar state, per-law last node.

### 5.2 Search done right
- Bind Ctrl+F/Cmd+F to focus the search input; Esc clears.
- Prev/next match navigation (Enter / Shift+Enter + ↑↓ buttons) scrolling
  through rendered `<mark>`s with a "3/47" counter.
- Fix the `Hl` highlighter bug (`LibraryShell.tsx:769`): global regex +
  `re.test()` is stateful across `.map` calls → randomly missed highlights.
  Use a non-global test or lowercase comparison.
- Debounce the query (~150ms) or `useDeferredValue`.

### 5.3 Caching
- Server: module-level `Map<slug, tree>` memo in `app/api/library/[slug]/route.ts`
  (currently re-reads + re-parses + 265-entry KB scan per article on every GET)
  plus `Cache-Control: public, max-age=3600`.
- Client: per-`regulationId` tree cache in `LibraryShell` so switching back is
  instant.

### 5.4 Reading comfort
- Theme toggle for the reader pane: dark / light / sepia, optional serif body.
- Keyboard paging: j/k or ←/→ previous/next article, space = page down.
- Reuse `AegisTtsButton` as a per-article "Vorlesen" button (uses Phase 4
  language setting).

### 5.5 Later / nice-to-have
- localStorage bookmarks (star per article, shown in TOC).
- Mobile: sidebars as overlay drawer below `md:`.
- Parser: recognize `ABSCHNITT` headings inside EU chapters.
- Replace native `title` glossary tooltips with the existing `GlossaryTooltip`
  component (touch support).

---

## Phase 6 — Housekeeping

- **README rewrite:** remove the phantom scoring engine, `/api/assess`,
  `/api/explain`, jsPDF reporting; document the actual Aegis architecture
  (mirror `docs/aegis/ARCHITECTURE.md`).
- **Split `AegisChatPanel.tsx`** (~1,230 lines) into MessageList, Composer,
  ToolProgress, UploadTray components; consider the same for `client-store.ts`.
- **API-route tests:** SSE event ordering, rate-limit behavior, upload →
  analyze → download (incl. ownership/404 from 1.3), error paths. Mock
  Anthropic SDK + Prisma.
- **Bundle check:** confirm three.js (`Compass3D`, `RegulationGraph`) stays out
  of the shared bundle (dynamic imports + analyzer).

---

## Suggested sequencing

| Order | Scope | Size |
|-------|-------|------|
| 1 | Phase 2 (memory) + 4.1/4.2 (voice) | small, immediate UX wins |
| 2 | Phase 1 (production blockers) | medium — needed before any public URL |
| 3 | Phase 3 (harness efficiency) | medium — cuts cost/latency per answer |
| 4 | Phase 5 (library) | medium — 5.1–5.3 small, 5.4+ incremental |
| 5 | Phase 6 (housekeeping) | ongoing |

Memory + voice first because they're small, user-visible, and unblock honest
testing of the agent; security before any deployment beyond localhost.
