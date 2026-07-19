# AEGIS — Technical Baseline

**Status:** Official capability & architecture baseline. Established before the next implementation phase.
**Date:** 2026-06-28
**Method:** Full code audit (7 parallel subsystem audits, every claim grounded in `file:line`). No speculation. Partial / unused / planned-only states are called out explicitly.
**Single question answered:** *What is AEGIS capable of today?*

> Reading guide: maturity labels are **Production-ready / Partial / Experimental / Unused / Planned-only**. Where the audit found a discrepancy between code paths, the runtime-effective value is stated.

---

## Part 1 — High-Level Architecture

AEGIS is a tool-using Claude agent embedded in the RegCompass Next.js app. It grounds every regulatory claim in a curated, Zod-validated knowledge base and refuses to answer outside it. Two transport modes (JSON and SSE streaming) share one orchestration core.

### Current execution flow

```
Browser (AegisChatPanel / AegisVoiceMode)
        │  POST /api/aegis   (Accept: text/event-stream → SSE, else JSON)
        ▼
app/api/aegis/route.ts
        │  resolveServiceAuth → rate-limit → user/approval gate → load soul block
        ▼
runAegis / runAegisStreaming  (lib/aegis/index.ts)
        │  Zod validate → sanitize input → startMemoryTurn (persist user turn, build replay seed)
        ▼
Router (lib/aegis/router.ts)
        │  classifyIntent (Haiku, CONVERSATIONAL only) → routeToModel → pick model
        ▼
Mode spec (lib/aegis/modes.ts)
        │  getModeSpec → [identity block | mode block] (cached) + voice/soul overlay (uncached)
        ▼
Outer loop (lib/aegis/loop.ts)  ── verify-retry envelope (max 3 attempts)
        │
        └─► Inner loop  ── tool-call cycle (Anthropic Messages API, client.ts)
                │  pre-guard (kill/compress/sanitize) → Claude call → tool_use? → execute tools
                │  tools: search_kb, get_requirements, get_crosswalk, read_source,
                │         analyze_document, fill_template   (lib/aegis/tools/*)  ──► KB (lib/kb)
                │  end_turn → post-guard (strip banned/cite-warn) → verifyResponse (citations)
                ▼
        Final text + citedIds + exitReason
        │  persistAssistantTurn → AegisResponse
        ▼
SSE token stream  ──►  client-store.ts  ──►  voice sink → sentence chunker → TTS (Browser-Web-Speech)
```

### Major components

| Component | File | Role |
|---|---|---|
| API route + auth | `app/api/aegis/route.ts` | Entry, cookie auth, rate-limit, SSE/JSON branch |
| Orchestrator | `lib/aegis/index.ts` | Validate, sanitize, memory turn, seed assembly, run loop, persist |
| Router | `lib/aegis/router.ts` | Intent classification, complexity, model selection |
| Mode spec | `lib/aegis/modes.ts` + `prompts/*` | System blocks, tool subset, token/iteration ceilings |
| Agentic loop | `lib/aegis/loop.ts` | Inner tool loop + outer verify-retry, graceful degradation |
| Anthropic client | `lib/aegis/client.ts` | Messages API, prompt-cache breakpoints, streaming |
| Guardrails | `lib/aegis/guardrails/*` | Pre (kill/compress/sanitize) + post (strip/warn) |
| Verify | `lib/aegis/verify.ts` | Deterministic citation/hallucination checks |
| Knowledge base | `lib/kb/*` | 265 requirements, JSON + Zod, lexical search |
| Memory | `lib/aegis/memory.ts`, `digest.ts`, `context/*` | Conversation persistence, seed replay, compaction |
| Soul | `lib/aegis/soul*.ts` | Style-only personalization profile |
| Voice | `lib/aegis/{speak,sentence,speech-chunk}.ts`, `components/Aegis*` | STT (browser), TTS, streaming playback |
| Documents | `lib/aegis/document-store.ts`, `parsers/*` | Upload, parse (PDF/DOCX/XLSX/TXT), Excel template-fill |

**Maturity:** the core request→response→persist→stream path is **Production-ready**.

---

## Part 2 — Current Modes

There are **exactly 4 modes** — a closed Zod enum (`types.ts:5-10`). **Voice is not a mode**; it is a request-level overlay flag (`AegisRequest.voice`). "Chat", "Search", "Research", "Planner" do **not exist** as modes.

> Runtime note on ceilings: the loop reads `maxTokens`/`maxIterations` from `getModeSpec` → `modes.ts` (`loop.ts:284,326`), **not** from `routeToModel`. `router.ts` also returns a flat `maxIterations: 10` and per-mode `maxTokens`, but those two `RouteDecision` fields are **dead code** — only `route.model` is consumed (`index.ts:274-275`). The effective ceilings are the `modes.ts` values below.

| Mode | Purpose | Trigger | Model | Tools | maxTok / maxIter (effective) | Maturity |
|---|---|---|---|---|---|---|
| **CONVERSATIONAL** | Free-form regulatory Q&A; default + fallback | Router catch-all; also fallback on classify failure | Haiku ≤0.5, **Sonnet** >0.5 (only mode that escalates) | search_kb, get_requirements, get_crosswalk, read_source | 2048 / 10 | **Production-ready** |
| **ASSESS** | Risk assessment of a described AI system | "assess an AI system… use case/sector/jurisdiction" | Sonnet (static) | same 4 read-only KB tools | 4096 / 15 | **Production-ready** |
| **GAP_ANALYZE** | Policy doc → gap matrix vs KB | "supplies a policy document or asks for gap analysis" | Sonnet (static) | +**analyze_document, fill_template** (widest set) | 4096 / 25 | **Implemented** (see Part 8) |
| **CONTROL_ADVISE** | Concrete control recommendations | "asks for control recommendations / implementation steps" | **Opus** (only Opus mode) | same 4 read-only KB tools | 4096 / 20 | **Implemented** |

Prompt rules (grounded): ASSESS is forbidden from declaring "compliant/non-compliant" (`mode_assess.ts`); GAP_ANALYZE must not invent gaps — policy silence ⇒ `partial`, never non-compliance (`mode_gap.ts:13`); CONTROL_ADVISE may not recommend controls outside the KB (`mode_control.ts`). The shared identity prompt (`prompts/identity.ts:33-56`) enforces 5 HARD RULES (tool-grounded only, mandatory `[R-...]` citations, no invented articles/fines, no legal advice, distinguish binding levels) and appends a deterministic KB table-of-contents.

**Voice overlay** (`prompts/voice.ts`, applied at `index.ts:277-292` when `voice:true`): spoken-style prompt, lowers ceilings to maxIter 5 / maxTok 1024, preserves HARD RULES. **Experimental/Partial** (Chrome-only STT, active development).

---

## Part 3 — Skills (implemented capabilities)

AEGIS has no formal "skill" abstraction in code; capabilities are realized through modes + tools. The genuinely implemented capabilities:

| Capability | Input | Output | Dependencies | Maturity |
|---|---|---|---|---|
| **Regulatory Q&A** | NL question | Cited answer (≤4 paras) | KB, search_kb | **Production-ready** |
| **Policy Assessment (ASSESS)** | AI-system description | Risk tiering + obligations, cited | KB | **Production-ready** |
| **Gap Analysis (GAP_ANALYZE)** | Policy text/doc | Gap matrix by regulation | KB + analyze_document | **Partial** (LLM reasoning solid; document-matching tool is keyword-heuristic) |
| **Control Recommendation (CONTROL_ADVISE)** | Gaps/requirements | Prioritized controls + steps | KB `controls[]` | **Implemented** |
| **Citation Verification** | Model output | Pass/fail + retry | verify.ts, allowedIds | **Production-ready** |
| **Document Analysis** | Uploaded PDF/DOCX/XLSX/TXT | covered/partial/missing findings | document-store, parsers | **Partial** (keyword overlap, not semantic) |
| **Excel template fill** | Policy + .xlsx template | Filled workbook (download) | excel-writer, exceljs | **Partial** (fills existing template only) |
| **Voice conversation** | Mic (Chrome) | Streamed spoken answer | browser STT, browser TTS (Web Speech) | **Experimental** |
| **Conversation memory** | Session/user | Persisted transcript + resume | Postgres, memory.ts | **Production-ready** |
| **Soul personalization** | User-confirmed prefs | Style block in prompt | soul-store | **Partial** (manual learning) |

**Not implemented** (despite being plausible "skills"): Risk Assessment as a distinct scored skill, Interview Coaching, Document Review beyond gap matching, multi-document comparison, report generation. Do not assume these exist.

---

## Part 4 — Routing

**Decision flow:**

```
message + mode (from client)
        │
   mode == CONVERSATIONAL ? ──no──► complexity := 0.5 (placeholder, classifier skipped)
        │ yes
        ▼
classifyIntent (Haiku LLM)  [default; env AEGIS_INTENT_CLASSIFIER]
   └─ 'heuristic' flag ► estimateComplexity() pure heuristic instead
        │  → {mode, complexity 0.0–1.0}   (fallback 0.5 on any parse error)
        ▼
routeToModel(mode, complexity)
   ASSESS         → Sonnet
   GAP_ANALYZE    → Sonnet
   CONTROL_ADVISE → Opus
   CONVERSATIONAL → complexity > 0.5 ? Sonnet : Haiku
        ▼
getModeSpec(mode, language)  → system blocks + tool subset + ceilings
        ▼
createToolRegistry(spec.defaultTools)  → only that mode's tools exposed to the model
```

- **Intent detection** (`router.ts:48-75`): default is a **blocking Haiku call on every CONVERSATIONAL turn** (env `AEGIS_INTENT_CLASSIFIER` defaults to `'haiku'`). The pure heuristic `estimateComplexity` exists but is **gated off** (Experimental).
- **Mode selection**: the client passes `mode`; the classifier's `mode` output is advisory. Only CONVERSATIONAL escalates by complexity (threshold 0.5, `router.ts:148`); structured modes are fixed for cost predictability.
- **Model routing**: `MODEL_IDS` = haiku `claude-haiku-4-5-20251001`, sonnet `claude-sonnet-4-6`, opus `claude-opus-4-7` (`types.ts:15-19`).
- **Tool routing**: per-mode subset via `MODE_TOOLS` (`modes.ts:26-31`); the registry exposes only that subset (`tools/index.ts:97-102`).
- **Prompt routing**: 2 cached system blocks `[identity | mode+language]`; voice/soul overlays appended uncached to preserve the shared cache prefix.

**Model-drift detection** is wired (`reportModelDrift`, logged on every call) — **Production-ready**.

---

## Part 5 — Voice

One subsystem: the **shipped web stack** — browser STT + browser TTS (Web Speech `speechSynthesis`), fully wired into chat. Speech is synthesized entirely on the device; there is no cloud TTS provider and no server-side speech service.

| Piece | State | Evidence |
|---|---|---|
| **Speech recognition (STT)** | **Partial — Chrome/Edge only** | Browser Web Speech API; two impls (`AegisVoiceMode.tsx:31-35`, `AegisVoiceButton.tsx:41-48`). Graceful "bitte Chrome verwenden" degradation. No server-side STT. STT residency not addressed (Google cloud). |
| **TTS — browser (Web Speech)** | **Production-ready** | `speechSynthesis`, prefers Google DE voice; per-user voice preference (`browser:<voiceURI>` tokens) via `/api/aegis/voice`. |
| **Streaming** | **Production-ready** | Sentence-level into TTS as tokens arrive (`client-store.ts:762-826`). |
| **Sentence detection + chunking** | **Production-ready** (well-tested) | `sentence.ts` (German abbrevs, decimals, unclosed `[R-...]`), `speech-chunk.ts` (pause-aware, adaptive flush). |
| **Playback / queueing** | **Production-ready** | FIFO queue (`AegisVoiceMode.tsx`); gesture-warmed `speechSynthesis` (`speak.ts` `primeSpeech`). |
| **Interruptibility (barge-in)** | **Partial** | Manual tap/hold barge-in works (`clearQueueAndStop`); **no live VAD** — `vad` pref exists but is unused. LLM keeps generating after barge-in (only client audio stops). |
| **Voice prompts** | **Production-ready** | Spoken overlay + per-user name directive (`prompts/voice.ts`). |
| **Telemetry** | **Production-ready (dev-only)** | `voice-debug.ts` + `AegisVoiceTimingOverlay.tsx`; "Zeit bis Audio" / "Runde gesamt". No server-side analytics. |
| **Context / conversation handling** | **Production-ready** | Voice turns flow through the same store/history as text; retraction (`onRetract`) keeps audio consistent with final answer. |
| **Inline voice (chat composer)** | **Production-ready (recent)** | `variant:'inline'` shares all logic; WebGL particle orb strip (`AegisChatPanel.tsx:1273-1305`). |

**Strengths:** low-latency sentence streaming, robust German sentence handling, clean degradation. **Limitations:** Chrome-locked STT, no VAD/auto-interruption, cloud STT residency gap, dev-only telemetry.

---

## Part 6 — Conversation Engine

| Aspect | State | Evidence |
|---|---|---|
| **Lifecycle** | **Production-ready** | `AegisConversation`/`AegisMessage` (Prisma); dense `seq` via transaction w/ one retry; fail-open to stateless on DB error (`memory.ts:107-447`). |
| **Memory (what persists)** | **Production-ready** | Full transcript authoritative; `citedIds`, `status`, `exitReason`, `model`, `toolCalls` (audit-only, never replayed). |
| **Ownership** | **Production-ready** | Session- and user-scoped reads; foreign/expired conversation = nonexistent. Caveat: `getDigest`/`messagesOf`/`getSeedRows` are deliberately unscoped (caller must scope first). |
| **History → context** | **Production-ready** | Client never sends history; server rebuilds replay seed from **complete user/assistant pairs only**, newest-first under 24K-token budget, re-ordered to valid alternation (`memory-seed.ts:48-101`). |
| **Compaction (in-loop)** | **Production-ready** | Triggered at **40K** input tokens; keep first 2 + last 4, Haiku-summarize middle; tool-pair-safe slice boundaries (`compress.ts`, `tool-pairing.ts`). R-ID preservation is **instruction-only** (no programmatic firewall here). |
| **Compaction (structured digest)** | **Partial** | `digest.ts` produces {decisions, openTasks, conclusions, preferencesObserved} with a citation firewall; but **only triggered manually** via a UI button — never automatic. |
| **Context-health gauge** | **Partial/advisory** | Pure scorer; **landmark mismatch** — gauge calibrated to 150K while live trigger is 40K. |
| **Soul** | **Partial** | Style-only personalization (6 sections); content firewall blocks facts/PII/R-IDs/dates/money. Wired into the prompt as an uncached trailing block (signed-in browser path only). Governance (dup/contradiction/health) is Production-ready but heuristic. **Learning is manual** (button-triggered `/soul/observe`). |
| **Personalization** | mixed | Greet-by-name is **voice-only**; **no fact memory** by design; `digest.preferencesObserved` captured but never bridged to soul (Planned-only). |
| **Client store** | **Production-ready** | Module singleton via `useSyncExternalStore`; survives SPA nav during 30–120s requests; owns SSE pipeline, voice sink, uploads, notifications. |

---

## Part 7 — Documents

`lib/reporting/` **does not exist** — there is no deterministic PDF report subsystem in this repo.

**Ingest / read:**

| Format | Read? | Parser |
|---|---|---|
| PDF | ✅ | `pdf-parse` (text layer only — no OCR; scanned PDFs yield nothing) |
| DOCX | ✅ | `mammoth` (read-only) |
| XLSX | ✅ | `exceljs` |
| TXT | ✅ | `TextDecoder` (rejects binary) |
| Legacy .xls | ❌ explicit | excluded server-side |
| Markdown | ❌ | no parser (only via mislabeled text/plain) |
| CSV | ❌ | no parser |
| Images | ❌ | no OCR |

**Can AEGIS:**

| Action | Answer |
|---|---|
| Read documents | **Yes** (PDF/DOCX/XLSX/TXT, 100K-char truncation, Postgres-backed store, 1h TTL) |
| Search within docs | **Partial** — keyword substring only, internal to gap analysis (no user "find in doc") |
| Analyze | **Yes, heuristic** — keyword-ratio matching, low maturity (no semantic/LLM body analysis) |
| Compare multiple docs | **No** — no multi-doc diff |
| Generate Excel | **Partial** — fills an **uploaded** template only; cannot create a workbook from scratch |
| Fill templates | **Yes** — status/priority/recommendation cells + "AEGIS Ergänzungen" sheet |
| Produce Word | **No** |
| Produce PDF | **No** |
| Export findings | **Yes**, but **only** via `fill_template` into an uploaded `.xlsx`; no standalone export |

---

## Part 8 — Gap Analysis (GAP_ANALYZE in depth)

**What happens today:**
1. **Policy processed** — uploaded PDF/DOCX/XLSX/TXT parsed to text (direct, no manual paste; `upload/route.ts:186-197`) and stored session-scoped (1h TTL). Or the model extracts sections directly from the message.
2. **Regulations retrieved** — the model (Sonnet) reads sections and calls `search_kb` + `get_crosswalk` per section (`mode_gap.ts`). `analyze_document` additionally runs a **keyword-overlap heuristic** between document chunks and KB requirements (`analyze_document.ts:82-106`) producing covered/partial/missing.
3. **Findings generated** — gap matrix grouped by regulation: requirement `[R-...]`, status (compliant/partial/non-compliant/not-applicable), justifying excerpt, one-sentence mismatch.
4. **Citations attached** — every `[R-...]` must be in the per-turn `allowedIds` (IDs the tools actually surfaced) **and** resolve in `KB.byId`; enforced deterministically by `verify.ts`.
5. **Severity** — **not computed by the engine.** No severity scoring exists in code; any severity is model prose. (The external answer-key assigns severities, but AEGIS does not.)
6. **Remediation** — produced as model prose under GAP_ANALYZE/CONTROL_ADVISE; constrained to KB `controls[]` in CONTROL_ADVISE.

**Answers to the sharp questions:**
- **Multiple regulations simultaneously?** **Yes** — search/crosswalk span all 19; matrix is grouped by regulation.
- **PDFs analyzed directly?** **Yes** (text-layer PDFs; no OCR for scans).
- **Findings exported to Excel?** **Yes, but only by filling an uploaded `.xlsx` template** (`fill_template` → `excel-writer`). No fresh Excel/PDF/Word generation.

**What is missing / weak:**
- `analyze_document` matching is **crude keyword overlap**, not semantic — recall/precision risk; missing-requirement cap of 50.
- **No severity model**, no de-duplication of findings, no false-positive suppression for mature sections.
- **No standalone report export** (Excel requires a user-supplied template; `generate_report` is an unimplemented Phase-4 stub returning `is_error`).
- **No automated quality eval** against ground truth (see `GAP_ANALYSIS_TESTING_PLAN.md`).

---

## Part 9 — Tooling

| Tool | Purpose | Modes | Maturity |
|---|---|---|---|
| **search_kb** | Lexical KB search, ≤10 summaries, DE↔EN synonyms | all 4 | **Production-ready** |
| **get_requirements** | Batch full records by ID (≤20) | all 4 | **Production-ready** |
| **get_crosswalk** | Cross-regulation overlap entries | all 4 | **Production-ready** |
| **read_source** | Fallback grep over raw legislation `.txt`; flagged `verified:false` | all 4 | **Production-ready** (path-hardened; the one sanctioned fs tool) |
| **analyze_document** | Keyword gap analysis of uploaded doc | GAP_ANALYZE | **Partial** (heuristic) |
| **fill_template** | Fill uploaded Excel template with findings | GAP_ANALYZE | **Partial** |
| **generate_report** | Phase-4 placeholder | **none** | **Unused stub** — removal candidate |

- **Unused / removal candidate:** `generate_report` is in no mode's tool list — dead in production (returns `not_implemented`/`is_error`). Keep only if Phase 4 is still planned.
- **Missing implementations:** none — every tool referenced in `MODE_TOOLS` resolves to a real executor (exhaustive `Record<ToolName,…>` typing).
- **Sandbox:** only `read_source` touches the filesystem (closed enum → fixed file map → `ALLOWED_DIR` containment). No tool makes network calls; doc tools reach data only through the TTL'd session store.

---

## Part 10 — Knowledge Base

- **Counts (verified from data today):** **265 requirements, 160 controls (nested in requirements), 19 regulations, 15 crosswalk entries** — matches `VERIFICATION_REPORT.md` exactly.
- **Regulations:** EU_AI_ACT (68), DORA (61), NIS2 (45), GDPR (15), REVDSG (11), FINMA_RS_2023_1 (8), FINMA_08_2024 (8), FINMA_RS_2018_3 (7), MARISK (6), DSA (6), DATA_ACT (5), BAIT (5), PRODUCT_LIABILITY (4), NIST_AI_RMF (4), BSIG (4), BDSG (4), ISO_42001 (2), ISO_42005 (1), ISO_23894 (1). Jurisdictions EU/CH/DE/INTL.
- **Storage:** static JSON files **Zod-validated at module load** (`lib/kb/index.ts`) — no DB, no build step. Postgres is used only for memory/documents/usage, never the KB.
- **Reference IDs:** hand-authored strings (`R-<REGABBREV>-<suffix>`), **no schema-enforced pattern** — historically fragile (a fixed `R-MARIK`/`R-MARISK` typo + dangling crosswalk refs; both clean now).
- **Citation validation (`verify.ts`):** deterministic, no model call. `citation_coverage` (article ref needs a `[R-...]`; cited IDs must be in `allowedIds` AND resolve in `KB.byId`), `no_hallucinated_regulations` (against the 19 short names), `unsupported_regulatory_claim`. `allowedIds` is built per turn from tool-result JSON, so the model can only cite what tools surfaced.
- **Retrieval:** **keyword-only.** No embeddings/vectors anywhere (grep-confirmed). Lexical scoring + a hand-built DE↔EN synonym table; `read_source` is the raw-text fallback.
- **Maturity:** **Moderately mature, curated, lexical.** Strong grounding; small corpus; bulk-extracted EU_AI_ACT/DORA/NIS2 (174 of 265) still await the paragraph-level manual QC the smaller regs received.

---

## Part 11 — Current Strengths

1. **Grounded-by-construction citations** — dual gate (`allowedIds` ∩ `KB.byId`) + deterministic verify make hallucinated regulations/IDs structurally hard. (`verify.ts`)
2. **Robust agentic loop** — verify-retry envelope, graceful cost/iteration degradation (forced tool-free answer at 80% budget), max_tokens continuation. (`loop.ts`)
3. **Production-grade conversation memory** — fail-open persistence, complete-pair replay, tool-pair-safe compaction. (`memory.ts`, `context/*`)
4. **Cost discipline** — exact 5-bucket cost accounting, $10 cap, prompt-cache prefix design, model routing for cost predictability. (`cost.ts`, `client.ts`)
5. **Low-latency voice** — sentence-level TTS streaming + well-tested German sentence/chunk detection. (`sentence.ts`, `speech-chunk.ts`)
6. **Disciplined prompt engineering** — cached identity+mode prefix, uncached personalization, HARD RULES, scope-guarding.
7. **Real document ingestion** — PDF/DOCX/XLSX/TXT parsed server-side into a TTL'd Postgres store with magic-byte validation.

---

## Part 12 — Current Weaknesses

**Design issues**
- Two disjoint compaction systems with mismatched landmarks (40K in-loop vs 150K gauge); structured digest never fires automatically.
- Soul auto-learning is manual; `digest.preferencesObserved` captured but never bridged.
- Severity, finding de-duplication, and false-positive suppression are absent from gap analysis.

**Technical debt**
- `routeToModel` returns `maxIterations`/`maxTokens` that the loop ignores — dead fields, confusing.
- `generate_report` is a dead stub in `ALL_TOOL_NAMES`.
- KB IDs are unvalidated free strings (history of typos/dangling refs).
- In-loop guardrail banned-input pattern path is effectively dead (message passed as `''`).
- Client accept filter lists `.xls` though the server rejects it.

**Missing capabilities**
- No semantic/vector retrieval (recall depends on a hand-built synonym table).
- No standalone report export (PDF/Word/fresh Excel); Excel needs a user template.
- No OCR, no Markdown/CSV ingest, no multi-document comparison.
- No automated gap-analysis quality eval against ground truth.
- No fact memory; greet-by-name is voice-only.

**Scalability / performance**
- Default intent classifier adds a **blocking Haiku call to every CONVERSATIONAL turn**.
- KB is loaded fully in-memory and lexically scanned per query — fine at 265 entries, won't scale to thousands without an index.
- Document analysis is O(chunks × requirements) substring matching.
- STT hard-locked to Chrome/Edge; cloud STT residency unaddressed.

---

## Part 13 — Capability Matrix

| Capability | Implemented | Production-ready | Partial | Planned/Stub | Priority |
|---|:--:|:--:|:--:|:--:|:--:|
| Chat (CONVERSATIONAL) | ✅ | ✅ | | | — |
| Policy Assessment (ASSESS) | ✅ | ✅ | | | — |
| Gap Analysis (GAP_ANALYZE) | ✅ | | ✅ | | **High** |
| Control Recommendation | ✅ | ✅ | | | Med |
| Citation Verification | ✅ | ✅ | | | — |
| Tool Routing | ✅ | ✅ | | | — |
| Model Routing / drift | ✅ | ✅ | | | — |
| Memory / persistence | ✅ | ✅ | | | — |
| Context compaction (in-loop) | ✅ | ✅ | | | Med |
| Structured digest | ✅ | | ✅ (manual) | | Med |
| Soul personalization | ✅ | | ✅ (manual learn) | | Low |
| Voice (TTS + streaming) | ✅ | ✅ | | | Med |
| Voice STT | ✅ | | ✅ (Chrome-only) | | Med |
| Voice barge-in / VAD | ✅ (manual) | | ✅ | | Low |
| Document ingest (PDF/DOCX/XLSX/TXT) | ✅ | ✅ | | | — |
| Document analysis (semantic) | | | ✅ (keyword) | | **High** |
| Excel export (template-fill) | ✅ | | ✅ | | Med |
| Report generation (PDF/Word/fresh) | | | | ❌ stub | **High** |
| Multimodal (images/OCR) | | | | ❌ | Low |
| Semantic / vector retrieval | | | | ❌ | **High** |
| Severity scoring (gap) | | | | ❌ | Med |
| Gap quality eval harness | | | | ❌ | **High** |
| Multi-document comparison | | | | ❌ | Low |

(Owner column intentionally blank — to be assigned by the team.)

---

## Part 14 — Roadmap (grounded in current state)

Ranked by business value × architectural leverage, with effort and dependencies:

1. **Gap-analysis quality + semantic retrieval** — *High value, High effort.* Replace `analyze_document` keyword overlap with embeddings/semantic matching; add severity, de-dup, false-positive suppression; build the eval harness against the answer key (`GAP_ANALYSIS_TESTING_PLAN.md`). Unblocks the platform's flagship workflow. *Depends on:* a vector store decision.
2. **Standalone report export** — *High value, Med effort.* Implement `generate_report` (currently a stub) to emit a self-contained Excel/PDF gap report without requiring a user template. *Depends on:* a writer lib (exceljs already present; add a PDF lib).
3. **Reconcile compaction** — *Med value, Low effort.* Unify the 40K/150K landmarks; auto-trigger the structured digest; add a programmatic R-ID firewall to in-loop compression. *Depends on:* nothing.
4. **Voice productionization** — *Med value, Med effort.* Cross-browser STT (residency-safe) and wire VAD for auto barge-in. TTS stays on-device (browser Web Speech) by design. *Depends on:* nothing.
5. **Tech-debt sweep** — *Low value, Low effort.* Remove dead `routeToModel` ceilings and `generate_report` from enums, fix the `.xls` accept mismatch, enforce a KB ID pattern. *Depends on:* nothing.
6. **Soul auto-learning** — *Low value, Med effort.* Bridge `digest.preferencesObserved` → soul proposals with the existing governance gates. *Depends on:* digest auto-trigger (#3).

---

## Part 15 — Final Assessment

**1. What can AEGIS genuinely do today?**
Hold a grounded, citation-verified conversation about EU/CH/DE/INTL financial-AI regulation; assess a described AI system and tier its risk; run a gap analysis of an uploaded policy and fill an Excel template with findings; recommend KB-backed controls; persist and resume conversations; and conduct a low-latency German voice conversation in Chrome.

**2. Production-ready features:** Conversational Q&A, ASSESS, citation verification, tool/model routing, memory + in-loop compaction, cost control, document ingestion, TTS streaming + sentence detection.

**3. Prototypes / partial:** Gap analysis (LLM solid, document-matching heuristic), structured digest (manual), soul personalization (manual learning), voice STT (Chrome-only) and barge-in (no VAD), Excel export (template-only).

**4. Missing architectural pieces:** semantic retrieval, standalone report generation, severity/de-dup in gap analysis, automated gap quality eval, OCR/Markdown/CSV ingest, multi-doc comparison, fact memory, cross-browser/residency-safe STT.

**5. What to build next:** semantic gap analysis + eval harness (#1) and standalone report export (#2) — they convert the flagship workflow from "demo-quality" to "deliverable."

**6. Workflows a customer could complete today:**
- Ask grounded regulatory questions and get cited answers.
- Get a risk assessment of an AI use case with obligations by binding level.
- Upload a policy PDF/DOCX, receive a gap matrix, and download a filled Excel **if they bring their own template**.
- Get prioritized control recommendations.
- Resume a prior conversation; converse by voice in Chrome.

**7. Workflows that would fail today:**
- "Give me a polished PDF/Word gap report" (no report generation).
- "Export findings to Excel" without supplying a template (no fresh-workbook export).
- "Analyze this scanned PDF / image / CSV / Markdown" (no OCR, those formats unsupported).
- "Compare these two policies" (no multi-doc comparison).
- "Rank gaps by severity" (no severity model).
- Reliable voice on Brave/Arc/Atlas/Firefox (STT Chrome/Edge-only).
- "Remember that I'm the CISO at Bank X" as a fact across sessions (no fact memory; soul is style-only).

---

## Deliverables index

1. **Architecture diagram** — Part 1.
2. **Capability matrix** — Part 13.
3. **Mode matrix** — Part 2.
4. **Skill inventory** — Part 3.
5. **Current execution flow** — Part 1 (diagram) + Part 4 (routing).
6. **Platform self-gap-analysis** — Parts 8, 12, 14.
7. **Recommended roadmap** — Part 14.

*Every conclusion above is grounded in the current codebase as of 2026-06-28. Stub/unused/partial states are labelled where found.*
