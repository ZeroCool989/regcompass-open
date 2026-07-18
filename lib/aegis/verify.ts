import { KB } from '@/lib/kb';
import type { VerifyCheck, VerifyResult } from './types';

/**
 * Tiered verification (3.2). HARD checks must pass — a failure retries and, if
 * unrecoverable, throws `verify_failed`. SOFT checks are advisory: on failure
 * the answer is returned with a `warnings` field instead of being discarded.
 *
 * Because `verifyResponse` runs the hard checks first (positions 1–3) and
 * returns the FIRST failure, a returned soft failure guarantees every hard
 * check already passed — so the loop can safely warn-and-accept.
 */
export const SOFT_CHECKS: ReadonlySet<VerifyCheck> = new Set<VerifyCheck>([
  'language_consistency',
  'no_false_ignorance',
]);

export function isSoftCheck(check: VerifyCheck): boolean {
  return SOFT_CHECKS.has(check);
}

/**
 * Build a "verified with warnings" result from a soft-check failure: the failed
 * check is marked 'warn', all others 'pass'. The `warnings` array is the
 * authoritative record of what tripped.
 */
export function warnedResult(failed: VerifyCheck, reason: string): VerifyResult {
  const checks = {} as Record<VerifyCheck, 'pass' | 'warn'>;
  for (const c of CHECK_ORDER) checks[c] = c === failed ? 'warn' : 'pass';
  return { ok: true, checks, warnings: [{ check: failed, reason }] };
}

/**
 * Deterministic verification of a finalised agent response.
 *
 * Runs 5 checks in order; returns the **first** failing check.
 * Source: docs/superpowers/specs/aegis-phase-1.md §4.7.
 *
 * No model call — purely regex + Set lookups. Safe to run in the hot path.
 */

export type VerifyInput = {
  text: string;
  /** Union of all KB requirement IDs that appeared in tool results this turn. */
  allowedIds: Set<string>;
  /** How many tool calls the agent issued. Drives `no_false_ignorance`. */
  toolsCalled: number;
  /**
   * Names of all tools the agent invoked this turn. Used by
   * `no_false_ignorance` to detect ignorance claims made without the
   * `read_source` fallback being tried.
   */
  toolsCalledNames?: string[];
  language: 'de' | 'en';
};

// `§`, `Rz.`, `Kap.` etc. aren't preceded by word chars in real text — `\b` from
// the spec doesn't fire on `§` (no word/non-word transition). Use negative
// lookbehind to match "not preceded by a word character", which catches all
// article-like markers consistently.
const ARTICLE_REF = /(?<!\w)(Art\.|§|Rz\.|Kap\.)\s*\d+/g;
const KB_CITATION = /\[R-[A-Z0-9]+-[A-Z0-9-]+\]/g;

// Bare KB entry IDs without brackets (e.g. "R-FINMA-001", "R-MARISK-435",
// "R-AIACT-009-5"). Stripped before regulation matching so the entry-ID
// suffix isn't mis-interpreted as part of a regulation name like FINMA-001.
const KB_CITATION_BARE = /\bR-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;

// FINMA and NIST use `(?!-\d)` negative lookahead so they don't match the
// bare digit-suffixed entry-ID form (FINMA-001, NIST-001) if any slipped
// past the pre-strip. Descriptive forms like "FINMA-Verordnung" or
// "NIST-Framework" still match — and will fail isKnownRegulation, which
// is the correct behaviour for unknown regulation names.
const REGULATION_MENTION =
  /\b(EU AI Act|DORA|GDPR|NIS2|DSA|Data Act|FINMA(?!-\d)[^\s,.]+|MaRisk|BAIT|BDSG|BSIG|revDSG|ISO ?\d{4,5}|NIST(?!-\d)[^\s,.]+|Product Liability(?:\s+Directive)?)\b/g;

// Official Journal designators of the EU acts in the KB. An answer citing an
// EU act by number ("Verordnung (EU) 2025/123") that is NOT in this set names
// a regulation outside the KB — the classic invented-regulation shape the
// name-based REGULATION_MENTION whitelist cannot catch. Extend together with
// lib/kb/regulations.json.
const KNOWN_EU_ACT_NUMBERS = new Set([
  '2016/679', // GDPR — Regulation (EU) 2016/679
  '2022/2554', // DORA — Regulation (EU) 2022/2554
  '2022/2555', // NIS2 — Directive (EU) 2022/2555
  '2022/2065', // DSA — Regulation (EU) 2022/2065
  '2023/2854', // Data Act — Regulation (EU) 2023/2854
  '2024/1689', // AI Act — Regulation (EU) 2024/1689
  '2024/2853', // Product Liability Directive — Directive (EU) 2024/2853
]);

// Curated KB texts legitimately reference further real acts (e.g. R-AIACT-002
// cites Verordnung 2018/1725 and Richtlinie 2016/680). An answer quoting a KB
// passage must never fail verify, so every act-number-shaped token that
// appears in curated KB text is allowlisted too. Deterministic at module load
// (pure KB derivation); only ever LOOSENS the hardcoded set above.
for (const r of KB.requirements) {
  const texts = [
    r.title, r.summary, r.body, r.enforcementConsequence, r.financialSectorGuidance,
    r.titleDe, r.summaryDe, r.bodyDe, r.enforcementConsequenceDe, r.financialSectorGuidanceDe,
  ];
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/\b(20\d{2}\/\d{1,4})\b/g)) {
      KNOWN_EU_ACT_NUMBERS.add(m[1]);
    }
  }
}

// Matches "Verordnung … 2025/123", "Richtlinie (EU) 2022/2555",
// "(EU) Nr. 2024/1689", "Regulation (EU) 2022/2554". Deliberately requires a
// legal-act keyword or the "(EU)" marker near the number so FINMA circular
// designators ("RS 2023/1") and plain dates never match.
const EU_ACT_DESIGNATOR =
  /(?:verordnung|richtlinie|regulation|directive)[^.\n]{0,30}?\b(20\d{2}\/\d{1,4})\b|\(EU\)\s*(?:Nr\.\s*)?(20\d{2}\/\d{1,4})\b/gi;

// Pre-compute the set of accepted regulation shortnames (lower-cased).
const KNOWN_REGULATIONS: Set<string> = new Set(
  KB.regulations.map((r) => r.shortName.toLowerCase().replace(/\s+/g, ' ').trim()),
);

const DE_MARKERS = new Set([
  'der', 'die', 'das', 'und', 'nicht', 'für', 'fur', 'sind', 'werden',
]);
const EN_MARKERS = new Set([
  'the', 'and', 'of', 'to', 'is', 'are', 'that', 'with',
]);

const IGNORANCE_DE = 'dies wird von der aktuellen wissensbasis nicht abgedeckt';
const IGNORANCE_EN = 'this is not covered by the current knowledge base';

// Clarification / meta markers (bilingual). A reply that asks the user to narrow
// scope is legitimately citation-free, so it is exempt from the
// `unsupported_regulatory_claim` check when paired with a question to the user.
const CLARIFICATION_MARKERS = [
  // EN
  'i need more', 'i need to clarify', 'could you', 'can you clarify',
  'please clarify', 'please specify', 'please let me know', 'which regulation',
  'are you asking', 'to answer this properly', 'to answer that properly',
  'to give you the most relevant', 'more information', 'more context',
  // DE
  'ich brauche mehr', 'können sie', 'koennen sie', 'bitte präzisieren',
  'bitte praezisieren', 'bitte spezifizieren', 'welche verordnung',
  'welche regulierung', 'meinen sie', 'mehr informationen', 'mehr kontext',
];

/**
 * Loose regulation-name lookup:
 *   - exact lowercase match in KNOWN_REGULATIONS, OR
 *   - any KNOWN entry contains the mention, OR vice versa, OR
 *   - if the mention is a German-style compound ("FINMA-Standards",
 *     "DORA-Anforderungen"), strip the hyphen suffix and check the
 *     base prefix against the whitelist.
 *
 * Handles "Product Liability" matching "Product Liability Directive",
 * "FINMA RS 2023/1" matching FINMA-prefixed regex hits, and German
 * compounds where a known regulation is used as a noun prefix.
 */
function isKnownRegulation(rawMention: string): boolean {
  const normalized = rawMention.toLowerCase().replace(/\s+/g, ' ').trim();
  if (KNOWN_REGULATIONS.has(normalized)) return true;
  for (const known of KNOWN_REGULATIONS) {
    if (known.includes(normalized) || normalized.includes(known)) return true;
  }
  // German compound words: extract base before the first hyphen and check
  // it against the whitelist. This allows natural phrasings like
  // "FINMA-Standards", "DORA-Anforderungen", "BDSG-konform" without
  // tripping the hallucination check.
  if (normalized.includes('-')) {
    const base = normalized.split('-')[0];
    if (base.length > 0) {
      if (KNOWN_REGULATIONS.has(base)) return true;
      for (const known of KNOWN_REGULATIONS) {
        if (known.includes(base) || base.includes(known)) return true;
      }
    }
  }
  return false;
}

function fail(
  check: VerifyCheck,
  reason: string,
  feedback: string,
): VerifyResult {
  return { ok: false, failed: check, reason, feedback };
}

// ───────────────────────── Individual checks ─────────────────────────

function checkCitationCoverage(text: string, allowedIds: Set<string>): VerifyResult | null {
  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    const articleMatches = para.match(ARTICLE_REF);
    const idMatches = para.match(KB_CITATION) ?? [];
    if (articleMatches && articleMatches.length > 0 && idMatches.length === 0) {
      const excerpt = para.slice(0, 100).replace(/\s+/g, ' ').trim();
      return fail(
        'citation_coverage',
        `Article reference without [R-...] citation in paragraph: "${excerpt}${para.length > 100 ? '…' : ''}"`,
        'Every paragraph that references an article, paragraph (§), Randziffer or chapter MUST also include the matching [R-XXXX-NNN] KB citation. Re-issue tool calls if you need to find the ID.',
      );
    }
    // If the agent did cite IDs, make sure they're in the allowed set AND that
    // they actually resolve to a KB entry (defense-in-depth: allowedIds is built
    // from tool output, so a non-resolving ID means a spurious match — never a
    // valid citation).
    for (const cit of idMatches) {
      const id = cit.slice(1, -1); // strip brackets
      if (!allowedIds.has(id)) {
        return fail(
          'citation_coverage',
          `Cited requirement ID "${id}" was never returned by a tool call.`,
          `Remove the [${id}] citation or call search_kb to retrieve the requirement first.`,
        );
      }
      if (!KB.byId(id)) {
        return fail(
          'citation_coverage',
          `Cited requirement ID "${id}" does not resolve to a knowledge-base entry.`,
          `Remove the [${id}] citation — it is not a valid requirement ID in the KB.`,
        );
      }
    }
  }
  return null;
}

function checkNoHallucinatedRegulations(text: string): VerifyResult | null {
  // Strip KB entry-ID citations before matching — they are not regulation names.
  // Without this, [R-FINMA-001] or bare R-NIST-GOV would be mis-read as an
  // unknown regulation called "FINMA-001" or "NIST-GOV".
  const stripped = text
    .replace(KB_CITATION, '')
    .replace(KB_CITATION_BARE, '');

  REGULATION_MENTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REGULATION_MENTION.exec(stripped)) !== null) {
    const mention = match[1];
    if (!isKnownRegulation(mention)) {
      return fail(
        'no_hallucinated_regulations',
        `Unknown regulation name in response: "${mention}".`,
        `Use only regulation short names that exist in the KB: ${[...KNOWN_REGULATIONS].join(', ')}.`,
      );
    }
  }

  // Invented EU acts cited by Official Journal number ("Verordnung (EU)
  // 2025/123") — the name whitelist above cannot see these.
  EU_ACT_DESIGNATOR.lastIndex = 0;
  while ((match = EU_ACT_DESIGNATOR.exec(stripped)) !== null) {
    const actNumber = match[1] ?? match[2];
    if (!KNOWN_EU_ACT_NUMBERS.has(actNumber)) {
      return fail(
        'no_hallucinated_regulations',
        `Unknown EU legal act number in response: "${actNumber}".`,
        `Only cite EU acts that exist in the KB (${[...KNOWN_EU_ACT_NUMBERS].join(', ')}); remove or reformulate the reference.`,
      );
    }
  }
  return null;
}

// Exported for the SECTIONED relaxed verify profile (epic F8) — grounded=false
// sections skip citation checks but keep language + non-empty. The check logic
// itself is unchanged; `verifyResponse` behaviour is byte-identical.
export function checkLanguageConsistency(text: string, language: 'de' | 'en'): VerifyResult | null {
  const tokens = text.toLowerCase().split(/\s+/).slice(0, 200);
  let de = 0;
  let en = 0;
  for (const tok of tokens) {
    const clean = tok.replace(/[^a-zäöüß]/gi, '');
    if (DE_MARKERS.has(clean)) de++;
    if (EN_MARKERS.has(clean)) en++;
  }
  // No clear signal either way → accept (verify is not a hard linter for very short replies).
  if (de === 0 && en === 0) return null;
  const dominant: 'de' | 'en' = de >= en ? 'de' : 'en';
  if (dominant !== language) {
    return fail(
      'language_consistency',
      `Response language mismatch: expected "${language}", detected "${dominant}" (de=${de}, en=${en}).`,
      `Re-write the response in ${language === 'de' ? 'German (Deutsch)' : 'English'} — the user's language preference is fixed for this conversation.`,
    );
  }
  return null;
}

// Exported for the SECTIONED relaxed verify profile (epic F8) — see above.
export function checkNonEmptyResponse(text: string): VerifyResult | null {
  if (text.trim().length < 10) {
    return fail(
      'non_empty_response',
      'Response was too short (< 10 trimmed characters).',
      'Provide a substantive answer with citations or explicitly state which part of the question is not covered by the KB.',
    );
  }
  return null;
}

function checkNoFalseIgnorance(
  text: string,
  toolsCalled: number,
  toolsCalledNames: string[] = [],
): VerifyResult | null {
  if (toolsCalled === 0) return null;
  const lower = text.toLowerCase();
  const claimsIgnorance =
    lower.includes(IGNORANCE_DE) || lower.includes(IGNORANCE_EN);
  if (!claimsIgnorance) return null;

  // Stronger signal: the agent claims ignorance but never tried the
  // read_source fallback. Point it at the fallback before letting the
  // claim through.
  const usedReadSource = toolsCalledNames.includes('read_source');
  if (!usedReadSource) {
    return fail(
      'no_false_ignorance',
      `Agent claimed the KB does not cover the topic, but read_source was not called as a fallback. ${toolsCalled} tool call(s) were issued, none of them read_source.`,
      'Before claiming the KB does not cover this topic, call read_source on the relevant regulation to search the raw legislation text. Only claim ignorance if both search_kb AND read_source return nothing useful.',
    );
  }

  return fail(
    'no_false_ignorance',
    `Agent claimed the KB does not cover the topic, but ${toolsCalled} tool call(s) were issued and may have returned results.`,
    'You called tools that returned results — synthesise an answer from those results rather than claiming ignorance.',
  );
}

/**
 * HARD check (3.x blind-spot fix): an answer must not assert regulatory content
 * while citing nothing. `citation_coverage` only fails an *uncited article
 * reference*; a confident answer that names a known regulation (e.g. "DORA is
 * mandatory…") with no [R-...] and no article number passed vacuously. This
 * closes that gap.
 *
 * Pass signal is **≥1 [R-...] citation** — `citation_coverage` runs first and
 * has already validated each cited ID, so any citation here is a real KB entry.
 *
 * Exemptions (legitimately citation-free, must NOT fail):
 *   - the canonical ignorance/refusal phrase, or
 *   - a clarification/meta reply (a clarification marker + a question to the user).
 *
 * Runs in the HARD tier (not in SOFT_CHECKS) → a failure retries and, if
 * unrecoverable, throws verify_failed instead of shipping an ungrounded claim.
 */
function checkUnsupportedRegulatoryClaim(
  text: string,
  _allowedIds: Set<string>,
): VerifyResult | null {
  // Any valid citation present → grounded enough; pass.
  if ((text.match(KB_CITATION) ?? []).length > 0) return null;

  const lower = text.toLowerCase();

  // Exempt the sanctioned refusal/ignorance reply.
  if (lower.includes(IGNORANCE_DE) || lower.includes(IGNORANCE_EN)) return null;

  // Exempt a clarification/meta reply: a marker phrase + a question to the user.
  if (text.includes('?') && CLARIFICATION_MARKERS.some((m) => lower.includes(m))) {
    return null;
  }

  // Regulatory-claim signal: a (known — unknowns already failed upstream)
  // regulation name, or an article/§/Rz./Kap. reference. `String.match` with a
  // global regex is non-stateful (unlike `.test()`), so no lastIndex juggling.
  const stripped = text.replace(KB_CITATION, '').replace(KB_CITATION_BARE, '');
  const namesRegulation = (stripped.match(REGULATION_MENTION) ?? []).length > 0;
  const hasArticleRef = (text.match(ARTICLE_REF) ?? []).length > 0;
  if (!namesRegulation && !hasArticleRef) return null;

  return fail(
    'unsupported_regulatory_claim',
    'Response asserts regulatory content (named a regulation or article reference) but cites no [R-...] KB requirement.',
    'Every regulatory claim must be grounded: call search_kb / get_requirements and cite the matching [R-XXXX-NNN] IDs, or explicitly state the KB does not cover this. Never state regulatory facts from memory.',
  );
}

// ───────────────────────── Public entry point ─────────────────────────

const CHECK_ORDER: VerifyCheck[] = [
  'citation_coverage',
  'no_hallucinated_regulations',
  'unsupported_regulatory_claim',
  'language_consistency',
  'non_empty_response',
  'no_false_ignorance',
];

export function verifyResponse(input: VerifyInput): VerifyResult {
  // Run checks in fixed order. Return the first failure.
  // Reordered slightly so cheap checks run first when possible;
  // CHECK_ORDER above documents the canonical order from the spec.

  // 1. Non-empty (cheapest)
  const empty = checkNonEmptyResponse(input.text);
  if (empty) return empty;

  // 2. Citation coverage
  const cit = checkCitationCoverage(input.text, input.allowedIds);
  if (cit) return cit;

  // 3. No hallucinated regulations
  const halluc = checkNoHallucinatedRegulations(input.text);
  if (halluc) return halluc;

  // 4. Unsupported regulatory claim (HARD — runs before the soft checks so the
  //    3.2 "first failure is soft ⇒ hard all passed" invariant holds).
  const ungrounded = checkUnsupportedRegulatoryClaim(input.text, input.allowedIds);
  if (ungrounded) return ungrounded;

  // 5. Language consistency
  const lang = checkLanguageConsistency(input.text, input.language);
  if (lang) return lang;

  // 6. No false ignorance
  const ignorance = checkNoFalseIgnorance(
    input.text,
    input.toolsCalled,
    input.toolsCalledNames,
  );
  if (ignorance) return ignorance;

  return {
    ok: true,
    checks: {
      citation_coverage: 'pass',
      no_hallucinated_regulations: 'pass',
      unsupported_regulatory_claim: 'pass',
      language_consistency: 'pass',
      non_empty_response: 'pass',
      no_false_ignorance: 'pass',
    },
  };
}

// Re-export for tests that want to assert the canonical order.
export { CHECK_ORDER };
