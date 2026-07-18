import { intEnv } from './env';

/**
 * Time-budget-aware graceful degradation for long reports.
 *
 * `verifyResponse` is cheap (regex/Set, <100ms). The wall-clock cost lives in
 * what a verify FAILURE triggers: a full-document citation-repair call and then
 * a full inner-loop re-generation. For a large report that fails verification
 * late, stacking those after the deadline guarantees the route's hard timeout
 * fires mid-retry — and the user loses a complete, already-streamed report.
 *
 * The outer loop uses the helpers here to decide, BEFORE starting an expensive
 * recovery, whether enough wall-clock remains. When it does not — and ONLY for
 * the citation family (missing/wrong [R-...] IDs), never for hallucinated
 * regulations or empty answers — it finalises the best draft with an explicit
 * "verification incomplete" banner instead of timing out. `verify.ts` is
 * unchanged; the returned verify result stays `ok: false` (honest — never a
 * "verified success"); the response carries `degraded: 'verify'`.
 */

/**
 * Minimum remaining wall-clock (ms) required to START each expensive recovery.
 * Sized to cover the recovery's own latency plus the finalize buffer. All three
 * are env-overridable so a Fluid-compute deployment can tune them without a
 * redeploy.
 */
export const REPAIR_RESERVE_MS = intEnv('AEGIS_REPAIR_RESERVE_MS', 45_000);
export const RETRY_RESERVE_MS = intEnv('AEGIS_RETRY_RESERVE_MS', 90_000);
/** Buffer kept free so the loop can build the banner and emit `done` BEFORE the route's hard deadline. */
export const FINALIZE_RESERVE_MS = intEnv('AEGIS_FINALIZE_RESERVE_MS', 8_000);
/**
 * Minimum remaining wall-clock to START a `max_tokens` continuation. A full
 * continuation pass is another model call of up to the mode's token ceiling —
 * measured ~142 s for 8 192 tokens on Sonnet — so starting one with less than
 * this floor guarantees the route's hard deadline fires mid-pass and the
 * client loses the streamed draft. Below the floor the loop finalises with
 * the explicit continuation note instead.
 */
export const CONTINUATION_TIME_FLOOR_MS = intEnv('AEGIS_CONTINUATION_TIME_FLOOR_MS', 75_000);

// ───────────────────── Budget-aware output sizing ─────────────────────

/**
 * Conservative generation speed for sizing a call's `max_tokens` to the
 * remaining wall-clock. Measured ~58 tok/s on Sonnet (dev log, 8 192 tokens in
 * 142 s); 40 assumes a slow day so the estimate errs toward smaller calls.
 */
export const GEN_TOKENS_PER_SEC = 40;

/** Never size a call below this — tiny ceilings produce useless truncated answers. */
export const MIN_CALL_TOKENS = 2_048;

/**
 * Cap a call's `max_tokens` to what fits in the remaining wall-clock, clamped
 * to [MIN_CALL_TOKENS, specMaxTokens]. With no deadline (JSON path, tests)
 * `timeLeft` is +Infinity and the spec ceiling passes through unchanged. The
 * floor may exceed the strict time fit — the route's hard deadline is the
 * backstop; the floor guarantees a usable answer instead of a 200-token stub.
 */
export function budgetedMaxTokens(specMaxTokens: number, timeLeft: number): number {
  if (!Number.isFinite(timeLeft)) return specMaxTokens;
  const fits = Math.floor((timeLeft / 1000) * GEN_TOKENS_PER_SEC);
  return Math.max(MIN_CALL_TOKENS, Math.min(specMaxTokens, fits));
}

// Read-only metrics for the user-facing banner count. These MIRROR the gate
// patterns in verify.ts on purpose — this module never gates, so it must not
// import from (or mutate) the verifier. Drift here only changes a displayed
// count, never whether an answer passes.
const ARTICLE_REF = /(?<!\w)(Art\.|§|Rz\.|Kap\.)\s*\d+/g;
const KB_CITATION = /\[R-[A-Z0-9]+-[A-Z0-9-]+\]/g;

/** Count paragraphs that name an article/§/Rz/Kap but carry no [R-...] citation. */
export function countUncitedClaimParagraphs(text: string): number {
  let n = 0;
  for (const para of text.split(/\n\n+/)) {
    const articleMatches = para.match(ARTICLE_REF);
    const idMatches = para.match(KB_CITATION) ?? [];
    if (articleMatches && articleMatches.length > 0 && idMatches.length === 0) n++;
  }
  return n;
}

/** The explicit, honest degradation banner (rendered as a `>` callout). */
export function buildDegradationBanner(n: number, language: 'de' | 'en'): string {
  if (language === 'en') {
    const claims = n === 1 ? '1 statement' : `${n} statements`;
    return `> ⚠️ **Verification incomplete:** ${claims} could not be checked against the knowledge base in the available time. The full report is shown below; please manually verify the passages that reference bare article numbers before relying on them.`;
  }
  const claims = n === 1 ? '1 Aussage' : `${n} Aussagen`;
  return `> ⚠️ **Verifizierung unvollständig:** ${claims} konnten in der verfügbaren Zeit nicht gegen die Wissensbasis geprüft werden. Der vollständige Bericht wird unten angezeigt; bitte prüfe die mit bloßen Artikelnummern versehenen Stellen vor der Verwendung manuell.`;
}

/** Prepend the degradation banner to the best draft. */
export function prependDegradationBanner(text: string, language: 'de' | 'en'): string {
  const n = Math.max(1, countUncitedClaimParagraphs(text));
  return `${buildDegradationBanner(n, language)}\n\n${text}`;
}

/**
 * Remaining wall-clock for recovery work, minus the finalize buffer. Returns
 * `+Infinity` when no deadline was supplied (the non-streaming JSON path and
 * unit tests) so every time gate is a no-op and behaviour is unchanged there.
 */
export function timeLeftMs(state: { deadlineAt?: number; now?: () => number }): number {
  if (state.deadlineAt === undefined) return Number.POSITIVE_INFINITY;
  const now = state.now?.() ?? Date.now();
  return state.deadlineAt - FINALIZE_RESERVE_MS - now;
}
