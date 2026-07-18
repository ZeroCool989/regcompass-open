import type {
  GuardrailCheckResult,
  GuardrailConfig,
} from '../types';

/**
 * Post-response checks. The loop runs these *after* the model returns an
 * `end_turn`. Output is the (possibly modified) text the loop will hand to
 * `verify()` next.
 *
 * Order:
 *   1. Empty response → `fail` (verify would catch this too, but failing early
 *      saves a regex pass).
 *   2. Banned phrases → strip the matching sentence(s); collect warnings.
 *   3. Citation pattern without [R-...] in the same paragraph → soft warning.
 *
 * `strip` and `warn` can compose: a stripped text may also produce a citation
 * warning. In that case we return `action: 'strip'` (the stronger signal) with
 * the warnings attached.
 */
/**
 * Negation markers that turn a banned-term mention into a disclaimer
 * (exported for tests). German: "keine/keinerlei Rechtsberatung", "nicht
 * rechtsverbindlich", "ersetzt keine Rechtsberatung", "weder … noch".
 * English: "not/no legal advice". Word order is free — the token only has to
 * co-occur with the banned term inside the same sentence.
 */
export const DISCLAIMER_NEGATION =
  /\b(kein(?:e|er|erlei)?|nicht|weder|ersetzt|no|not|never)\b/i;

export function checkPost(
  config: GuardrailConfig,
  responseText: string,
  _citations: string[],
): GuardrailCheckResult {
  if (responseText.trim().length < config.minResponseLength) {
    return {
      action: 'fail',
      reason: `Response too short (${responseText.trim().length} chars, min ${config.minResponseLength}).`,
    };
  }

  // ──────── Strip banned phrases (sentence-level, negation-aware) ────────
  // The banned terms target the model CLAIMING to give legal advice /
  // binding statements. A sentence that NEGATES the term ("Dies ist keine
  // Rechtsberatung", "this is not legal advice") is the mandated disclaimer
  // from docs/CLAUDE.md — stripping it would delete exactly the sentence the
  // operating rules require (ARCH-09).
  const stripped: string[] = [];
  let cleaned = responseText;
  for (const pattern of config.bannedOutputPatterns) {
    // Make sure the pattern has global flag so we catch all hits.
    const globalPattern = pattern.global
      ? pattern
      : new RegExp(pattern.source, pattern.flags + 'g');

    cleaned = cleaned.replace(/[^.!?\n]*[.!?]/g, (sentence) => {
      if (globalPattern.test(sentence)) {
        globalPattern.lastIndex = 0; // reset between iterations
        if (DISCLAIMER_NEGATION.test(sentence)) {
          return sentence; // negated mention → disclaimer, keep it
        }
        stripped.push(sentence.trim());
        return '';
      }
      globalPattern.lastIndex = 0;
      return sentence;
    });
  }
  // Collapse the double-spaces / leading whitespace left by sentence removal.
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/^\s+/, '').trim();

  // ──────── Citation warnings (soft — never strips) ────────
  const warnings: string[] = [];
  const paragraphs = cleaned.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (
      config.citationWarningPattern.test(para) &&
      !/\[R-[A-Z0-9]+-[A-Z0-9-]+\]/.test(para)
    ) {
      warnings.push(
        `Paragraph references a regulation article without a matching [R-...] citation: "${para.slice(0, 80)}${para.length > 80 ? '…' : ''}"`,
      );
    }
  }

  // After stripping, check we still have enough content.
  if (cleaned.trim().length < config.minResponseLength) {
    return {
      action: 'fail',
      reason: `Response too short after stripping ${stripped.length} banned phrase(s).`,
    };
  }

  if (stripped.length > 0) {
    return { action: 'strip', text: cleaned, stripped, warnings };
  }
  if (warnings.length > 0) {
    return { action: 'warn', text: cleaned, warnings };
  }
  return { action: 'ok' };
}
