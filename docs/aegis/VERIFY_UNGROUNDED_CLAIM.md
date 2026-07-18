# Verify fix — `unsupported_regulatory_claim` (ungrounded-answer blind spot)

Closes a live gap surfaced by the 3.4 eval: an answer that asserts regulatory
content with **zero citations** could pass verify, because `citation_coverage`
only fails an *uncited article reference* — not a wholly ungrounded claim. On the
default-Haiku path this undercut the no-fabrication guarantee (e.g. "What is
DORA?" → Haiku answered "binding level: mandatory… 61 DORA requirements" with no
`[R-…]` and `verify.ok: true`).

## The check (Option B, hard)

Added `unsupported_regulatory_claim` in `verify.ts`, run in the **hard tier**
after `citation_coverage` / `no_hallucinated_regulations` and before the soft
checks (preserves the 3.2 invariant: a returned soft failure ⇒ all hard checks
passed). Not in `SOFT_CHECKS`, so a failure **retries and, if unrecoverable,
throws `verify_failed`** instead of shipping.

Logic, exemption-first:
1. **Pass** if the text carries **≥1 `[R-…]` citation** (`citation_coverage`
   already validated each cited id, so any citation here is a real KB entry).
2. **Exempt** (pass) the sanctioned non-answers:
   - the canonical ignorance/refusal phrase (`IGNORANCE_DE/EN`), or
   - a clarification/meta reply: a bilingual clarification marker **plus** a `?`.
3. Otherwise **fail** if the answer makes a regulatory claim — names a known
   regulation (`REGULATION_MENTION`; unknowns already failed upstream) **or**
   carries an article/§/Rz./Kap. reference (`ARTICLE_REF`).

## Why this separates "claimed, cited nothing" from "didn't need to cite"

| Reply | Names reg / art-ref | Has `[R-…]` | Clarif/refusal marker | Result |
|---|---|---|---|---|
| "DORA is mandatory… 61 requirements" | yes | no | no | **fail** |
| "I need more info — which regulation?" | yes | no | **yes + ?** | pass |
| "This is not covered by the current knowledge base." | maybe | no | **ignorance phrase** | pass |
| grounded answer with `[R-DORA-001]` | yes | **yes** | no | pass |
| "Hello, I'm AEGIS." | no | no | n/a | pass |

## Telemetry (3.4 signal)

The outer loops (`runOuterLoop` / `runOuterLoopStreaming`) push `ungrounded_claim`
to `state.guardrailsTriggered` once per turn when this hard check fires. Combined
with the run's `exitReason` downstream (already surfaced by the usage route's
group-by), this yields:
- **ungrounded-answer rate** = turns whose `guardrailsTriggered` contains
  `ungrounded_claim`;
- **recovered vs not** = that token with `exitReason='done'` (retried into a
  grounded answer) vs `exitReason='verify_failed'` (could not ground).

This is direct signal for the 3.4 routing decision: a high ungrounded rate on the
Haiku path is an argument against flipping `AEGIS_INTENT_CLASSIFIER='heuristic'`.

## Interaction with 3.2 and the badge

- **Hard, not soft** → never renders the amber "⚠ Verifiziert mit Warnung" badge
  and never the green "✓ Verifiziert" on an ungrounded answer: it either retries
  into a genuinely grounded `ok` (green) or ends in `verify_failed` (error
  surface, no badge).
- Raises retries/cost: a previously-shipped ungrounded answer now retries
  (forcing tool use). Near the 3.1 ceiling the forced answer is itself
  re-verified; if still ungrounded the turn ends in `verify_failed` rather than
  shipping a fabrication.

## Scope residuals (conscious limits, NOT TODOs)

1. **Generic assertion without a regulation name slips.** The claim signal is a
   *known regulation name* or an *article/§ reference*. An answer that asserts
   regulatory-flavoured content while naming no regulation and no article (e.g.
   "logging is mandatory for all financial entities") carries no claim signal and
   passes. Accepted: broadening to "any normative assertion" would false-positive
   on ordinary prose.
2. **≥1 citation grounds the whole answer for this check.** A single valid
   citation is the pass signal; an answer that cites one id and then makes
   *additional* uncited regulation-name claims is not caught by this check.
   `citation_coverage` still catches an uncited *article reference* per paragraph,
   but not an uncited *regulation-name* assertion once any citation is present.
   Accepted: per-claim grounding is a larger design change; the wholly-ungrounded
   case (the live blind spot) is what this closes.

## Tests

`lib/aegis/__tests__/verify.test.ts` — 7 new: ungrounded reg answer → fails;
clarification (marker + ?) → passes; canonical refusal → passes; grounded answer
→ passes; pure conversational → passes; partially grounded (≥1 citation + extra
uncited mention) → passes (no over-fire); grounded answer with an article ref →
passes BOTH `citation_coverage` and the new check (regression). Pre-existing
fixtures that isolated other checks with uncited regulation text were grounded
with a real citation so they still exercise their target check.

`lib/aegis/__tests__/loop.test.ts` — fixtures grounded (seeded allowedId +
`[R-AIACT-001]`) so loop-mechanics tests pass the stricter verify.

Gate: `nvm use 22 && npx tsc --noEmit && npx vitest run` → 327 green.

## Ship note

The blind spot is **live on prod** (default-Haiku path). This ships through its
own gate (preview/regression → merge) next; it shouldn't wait long.
