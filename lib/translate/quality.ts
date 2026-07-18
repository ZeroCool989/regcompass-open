import { KEY_REGULATORY_TERMS, type TargetLang } from './glossary';

/**
 * Lightweight, DETERMINISTIC translation quality review focused on regulatory
 * meaning. It NEVER rewrites the translation — it only surfaces warnings:
 *   1. Obligation-strength balance — did "shall/must" vs "may/should" survive?
 *   2. Key-term consistency — is one concept rendered inconsistently?
 *
 * This is a heuristic safety net (a human still reviews); the glossary seed it
 * shares with `glossary.ts` is the basis for a future approved-term memory.
 */

export type QualityWarning = {
  type: 'obligation_strength' | 'obligation_loss' | 'term_consistency';
  message: string;
  detail?: string;
};

/**
 * Obligation modal lexicons per language. `strong` = mandatory (must/shall),
 * `weak` = discretionary (may/should). Entries are case-insensitive regex
 * source strings, matched on word boundaries.
 */
const OBLIGATION_LEXICON: Record<string, { strong: string[]; weak: string[] }> = {
  EN: {
    strong: ['shall', 'must', 'shall not', 'must not', 'required to', 'is required to', 'are required to'],
    weak: ['may', 'should', 'can', 'is encouraged to'],
  },
  DE: {
    strong: ['muss', 'müssen', 'hat zu', 'haben zu', 'ist verpflichtet', 'sind verpflichtet', 'darf nicht', 'dürfen nicht'],
    weak: ['soll', 'sollte', 'sollten', 'kann', 'können', 'darf(?!\\s+nicht)', 'dürfen(?!\\s+nicht)', 'mag'],
  },
  ES: {
    strong: ['deberá', 'deberán', 'debe', 'deben', 'tendrá que', 'no podrá', 'no podrán'],
    weak: ['podrá', 'podrán', 'puede', 'pueden', 'debería', 'deberían'],
  },
  FR: {
    strong: ['doit', 'doivent', 'est tenu de', 'sont tenus de', 'ne doit pas', 'ne doivent pas'],
    weak: ['peut', 'peuvent', 'devrait', 'devraient'],
  },
  IT: {
    strong: ['deve', 'devono', 'è tenuto a', 'sono tenuti a', 'non può', 'non possono'],
    weak: ['può', 'possono', 'dovrebbe', 'dovrebbero'],
  },
  NL: {
    strong: ['moet', 'moeten', 'dient te', 'dienen te', 'mag niet', 'mogen niet'],
    weak: ['mag(?!\\s+niet)', 'mogen(?!\\s+niet)', 'zou moeten', 'kan', 'kunnen'],
  },
  PL: {
    strong: ['musi', 'muszą', 'nie może', 'nie mogą'],
    weak: ['może', 'mogą', 'powinien', 'powinna', 'powinno', 'powinny'],
  },
};

function countMarkers(text: string, patterns: string[]): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const p of patterns) {
    // \b doesn't work before/after non-ASCII letters; use Unicode-aware guards.
    const re = new RegExp(`(?<![\\p{L}])(?:${p})(?![\\p{L}])`, 'giu');
    const matches = lower.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

const STRONG_RATIO_DELTA = 0.3; // flag when strong-obligation share shifts > 30%
const MIN_SOURCE_OBLIGATIONS = 3;

/**
 * Review a translation for regulatory-meaning drift. `sourceLang` is the
 * normalized 2-letter base (e.g. "ES"); pass null/unknown to skip the
 * source-vs-target obligation comparison (term consistency still runs).
 */
export function reviewTranslation(
  sourceText: string,
  translatedText: string,
  sourceLang: string | null,
  target: string,
): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const targetKey = target.toUpperCase();

  // The quality lexicons/glossary are currently tuned for DE/EN targets. For
  // other targets we translate fine but skip these extra warnings.
  if (targetKey !== 'DE' && targetKey !== 'EN') return warnings;
  const targetLang = targetKey as TargetLang;

  // 1) Obligation-strength balance (needs both source + target lexicons).
  const src = sourceLang ? OBLIGATION_LEXICON[sourceLang.toUpperCase()] : undefined;
  const tgt = OBLIGATION_LEXICON[targetLang];
  if (src && tgt) {
    const sStrong = countMarkers(sourceText, src.strong);
    const sWeak = countMarkers(sourceText, src.weak);
    const tStrong = countMarkers(translatedText, tgt.strong);
    const tWeak = countMarkers(translatedText, tgt.weak);
    const sTotal = sStrong + sWeak;
    const tTotal = tStrong + tWeak;

    if (sTotal >= MIN_SOURCE_OBLIGATIONS && tTotal >= 1) {
      const sRatio = sStrong / sTotal;
      const tRatio = tStrong / tTotal;
      if (Math.abs(sRatio - tRatio) > STRONG_RATIO_DELTA) {
        const dir = tRatio < sRatio ? 'weakened' : 'strengthened';
        warnings.push({
          type: 'obligation_strength',
          message: `Obligation strength may have ${dir} — verify mandatory ("shall/must") vs discretionary ("may/should") wording.`,
          detail: `source strong/total ${sStrong}/${sTotal}, translation strong/total ${tStrong}/${tTotal}`,
        });
      }
    }
    // Large drop in total obligation markers → obligations possibly lost.
    if (sTotal >= 5 && tTotal < sTotal * 0.5) {
      warnings.push({
        type: 'obligation_loss',
        message: 'Fewer obligation terms in the translation than the source — check that no requirements were dropped.',
        detail: `source obligations ${sTotal}, translation obligations ${tTotal}`,
      });
    }
  }

  // 2) Key-term consistency (translation only).
  for (const term of KEY_REGULATORY_TERMS) {
    const variants = term.variants[targetLang];
    const present = variants.filter((v) => countMarkers(translatedText, [escapeForCount(v)]) > 0);
    if (present.length > 1) {
      const totalOcc = present.reduce((n, v) => n + countMarkers(translatedText, [escapeForCount(v)]), 0);
      if (totalOcc >= 2) {
        warnings.push({
          type: 'term_consistency',
          message: `Inconsistent rendering of "${term.canonical[targetLang]}" — unify to one term.`,
          detail: `found: ${present.join(', ')}`,
        });
      }
    }
  }

  return warnings;
}

/** Escape a literal glossary variant for use inside the marker regex. */
function escapeForCount(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
