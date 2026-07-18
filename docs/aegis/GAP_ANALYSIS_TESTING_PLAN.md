# AEGIS Gap-Analysis & Mode Testing Plan

**Status:** planning only — no harness written yet.
**Compiled:** 2026-06-28, from an audit of `lib/aegis/__tests__` (310 unit cases) and `scripts/intent-eval.mts`.
**Ground-truth artifact:** `Expected_Gap_Analysis_Answer_Key.md` (8 seeded DORA gaps in policy `GRP-RSK-ICT-014 v3.2`).

---

## 1. The four modes under test

The router (`lib/aegis/router.ts`) classifies every turn into one mode; each mode has its own
prompt, tool subset, token budget and iteration cap (`lib/aegis/modes.ts`):

| Mode | Purpose | Extra tools | maxTok | maxIters | Model route |
|------|---------|-------------|--------|----------|-------------|
| CONVERSATIONAL | free-form reg Q&A | — | 2048 | 10 | Haiku ≤0.5, else Sonnet |
| ASSESS | assess an AI system vs regs | — | 4096 | 15 | Sonnet |
| GAP_ANALYZE | policy → gap matrix | `analyze_document`, `fill_template` | 4096 | 25 | Sonnet |
| CONTROL_ADVISE | concrete control recs | — | 4096 | 20 | Opus |

GAP_ANALYZE rule (`prompts/mode_gap.ts`): classify each KB requirement as
compliant / partial / non-compliant / not-applicable; cite `[R-...]` + policy excerpt;
**"do not invent gaps"** — silence ⇒ `partial`, never `non-compliant`.

---

## 2. What is already covered (310 unit cases)

| Area | File | Cases | Notes |
|------|------|-------|-------|
| Intent → mode classification | `router.test.ts` | 25 | parse/fallback + `routeToModel` + complexity heuristic |
| Model-route correctness | `router.test.ts` | (above) | ASSESS/GAP→Sonnet, CONTROL→Opus, CONV→Haiku/Sonnet |
| Response verification | `verify.test.ts` | 43 | citation coverage, hallucinated-regulation guard, non-empty |
| Guardrails pre/post | `guardrails.test.ts` | 21 | iteration/cost/context kill, injection sanitize, banned phrases |
| Outer agent loop | `loop.test.ts` | 25 | happy paths, iteration handling |
| Tool execution | `tools.test.ts` | 47 | `executeSearchKb` etc. |
| Tools sandbox boundary | `boundary.test.ts` | 4 | tools must not touch net/fs |
| Context compress / cost | `compress.test.ts`, `cost.test.ts` | 17 | R-ID preservation under compaction |
| Tool-pair repair | `tool-pairing.test.ts` | 10 | tool_use/tool_result kept intact across compaction |
| Memory / conversation routes | `memory.test.ts`, `conversation-routes.test.ts` | 23 | ownership, persistence |
| Excel parse/write | `parsers.test.ts` | 14 | `fill_template` substrate |
| Voice/TTS plumbing | `sentence/speech-chunk/...` | ~55 | not gap-related |

Plus the legacy eval `scripts/intent-eval.mts` — real-API check of the *intent heuristic*,
writes `docs/aegis/PHASE3_4_INTENT_VALIDATION.md`. Throwaway/dev-only.

---

## 3. The coverage gap

Everything above tests **mechanics** (does the loop route, cite, sanitize, stay in budget).
**Nothing tests gap-analysis OUTPUT QUALITY** — i.e. given a real seeded policy, does AEGIS
find the right gaps and stay quiet on the mature sections. That is exactly what the answer key
is for, and there is no harness consuming it yet.

`intent-eval.mts` is also skewed: its `SET` is almost entirely CONVERSATIONAL bands — it barely
exercises GAP_ANALYZE / ASSESS / CONTROL_ADVISE routing.

---

## 4. Proposed test levels (build later, in this order)

### L1 — Mode-routing eval (cheap, no policy file needed)
Extend `intent-eval.mts` `SET` with labelled GAP_ANALYZE / ASSESS / CONTROL_ADVISE prompts
(e.g. "Here is our ICT policy, find the gaps" → GAP_ANALYZE; "recommend controls for X" →
CONTROL_ADVISE). Assert classified mode == expected. Catches misrouting before spending tokens
on a full run.

### L2 — Gap-analysis quality eval (the real test) — **blocked: needs the seeded policy file**
Feed the seeded policy through the GAP_ANALYZE pipeline, then score output against the 8-gap key:

- **Recall** — of 8 seeded gaps, how many found, with the correct DORA article anchor
  (Art. 8, 6(8), 5(2)/13, 28–30, 11–12, 17–19, 6(5)–(6), 6(5)).
- **Precision / false positives** — did it raise findings on the *mature* sections?
  The key states over-triggering is itself a failure signal — weight this heavily.
- **Grounding** — every finding cites a real `[R-...]` ID and a genuine policy excerpt
  (cross-check against the `verify.ts` / guardrail layer already unit-tested).
- **Severity alignment** — compare to the key's suggested severities (High / Medium–High / Medium).

Shape: run pipeline → judge step compares to key → emit recall/precision report (mirror how
`intent-eval.mts` writes a markdown summary). Keep it dev-only / real-API, gated behind an env flag.

### L3 — Regression guard (optional, later)
Snapshot the L2 scores; fail CI if recall drops or false-positives rise after prompt/KB changes.

---

## 5. Inputs still needed

1. **The seeded policy document** (`GRP-RSK-ICT-014 v3.2`, ABC Digital Bank AG) — the input AEGIS
   analyzes. We have the answer key but not the policy it grades.
2. Decision: run L2 against **dev KB + real Anthropic API** (like `intent-eval.mts`) or stub the
   model. Real API gives true quality signal; stub only tests plumbing.
3. Pass/fail thresholds (e.g. recall ≥ 7/8, zero false positives on mature sections).

---

## 6. Open housekeeping (surfaced during audit)

- 3 local branches are fully merged into `main` and prunable: `fix/aegis-compaction-tool-pairing`,
  `phase-4-voice-foundation`, `phase-1-2-foundation`.
- `feat/inline-voice-mode` (current, 9 ahead) appears to be the superset voice branch to land;
  `feat/voice-greeting-name-at-end` and `feat/aegis-voice-streaming` look like subsets.
