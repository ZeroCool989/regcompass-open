import {
  verifyResponse,
  checkLanguageConsistency,
  checkNonEmptyResponse,
} from '../verify';
import type { VerifyResult } from '../types';

/**
 * Section verification (epic F8):
 *   - grounded sections → `verifyResponse` UNCHANGED, with the section-local
 *     `allowedIds` scope (only IDs retrieved by THIS section's tool calls).
 *   - grounded=false (advisory) sections → relaxed profile: citation checks
 *     don't apply to content that by contract has no KB anchor; language
 *     consistency and non-empty remain.
 *
 * `KNOWN_EXTERNAL_STANDARDS` (PR 2, F8): an allowlist of real-world standards
 * that are NOT in the KB but are legitimate to reference in a report (ISO/IEC
 * 27001, SOC 2, …). SECTIONED ONLY — single-pass verify is untouched. A hit is
 * NEVER a silent pass: the mention is returned as an `externalRefs` entry, the
 * executor appends the "unverified reference" footnote and writes an audit
 * event, and no repair pass is burned on it (F8: kein Retry).
 */

/**
 * External standards recognisable as legitimate references. Deliberately a
 * NAME list (matched case-insensitively, number suffixes allowed) rather than a
 * pattern for "anything ISO-shaped" — an invented "ISO 99999" must still fail
 * verify. KB-known standards (ISO 42001/42005/23894, NIST AI RMF) are handled
 * by the KB whitelist upstream and do not belong here.
 */
export const KNOWN_EXTERNAL_STANDARDS: ReadonlyArray<string> = [
  'ISO/IEC 27001',
  'ISO 27001',
  'ISO/IEC 27002',
  'ISO 27002',
  'ISO/IEC 27005',
  'ISO/IEC 27701',
  'ISO 27701',
  'ISO 22301',
  'ISO 31000',
  'ISO 9001',
  'ISO/IEC 20000',
  'ISO/IEC 22989',
  'ISO/IEC 23053',
  'ISO/IEC 38507',
  'IEC 62443',
  'SOC 2',
  'SOC-2',
  'PCI DSS',
  'PCI-DSS',
  'NIST SP 800-53',
  'NIST SP 800-30',
  'NIST CSF',
  'NIST Cybersecurity Framework',
  'TISAX',
  'COBIT',
  'ITIL',
  'CIS Controls',
  'OWASP',
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest-first so "ISO/IEC 27001" wins over "ISO 27001" prefix overlaps. */
const EXTERNAL_STANDARD_RE = new RegExp(
  `(?<![\\w/-])(${[...KNOWN_EXTERNAL_STANDARDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})(?::\\d{4})?(?![\\w-])`,
  'gi',
);

export function findExternalStandardRefs(text: string): string[] {
  EXTERNAL_STANDARD_RE.lastIndex = 0;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = EXTERNAL_STANDARD_RE.exec(text)) !== null) {
    // Canonical casing from the allowlist, not whatever the model wrote.
    const canonical = KNOWN_EXTERNAL_STANDARDS.find(
      (s) => s.toLowerCase() === m![1].toLowerCase(),
    );
    found.add(canonical ?? m[1]);
  }
  return [...found];
}

/** Neutral placeholder that carries no regulation-name or article shape. */
function stripExternalStandards(text: string): string {
  EXTERNAL_STANDARD_RE.lastIndex = 0;
  return text.replace(EXTERNAL_STANDARD_RE, 'dem genannten externen Standard');
}

export type SectionVerifyInput = {
  text: string;
  grounded: boolean;
  allowedIds: Set<string>;
  toolsCalled: number;
  toolsCalledNames: string[];
  language: 'de' | 'en';
};

const RELAXED_PASS: VerifyResult = {
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

export type SectionVerifyOutcome = {
  verify: VerifyResult;
  /**
   * External standards (allowlist hits) that verify only passed because of the
   * F8 allowlist. Non-empty ⇒ the executor MUST footnote them as unverified
   * references and write an audit event — never a silent pass.
   */
  externalRefs: string[];
};

function rawVerify(input: SectionVerifyInput, text: string): VerifyResult {
  if (input.grounded) {
    return verifyResponse({
      text,
      allowedIds: input.allowedIds,
      toolsCalled: input.toolsCalled,
      toolsCalledNames: input.toolsCalledNames,
      language: input.language,
    });
  }
  return (
    checkNonEmptyResponse(text) ??
    checkLanguageConsistency(text, input.language) ??
    RELAXED_PASS
  );
}

export function verifySection(input: SectionVerifyInput): SectionVerifyOutcome {
  // F8: every allowlist hit is footnoted — consistently, whether or not the
  // verify regexes happen to flag that particular designator form ("ISO/IEC
  // 27001" is invisible to REGULATION_MENTION, "ISO 27001" is not).
  const externalRefs = findExternalStandardRefs(input.text);

  const first = rawVerify(input, input.text);
  if (first.ok) return { verify: first, externalRefs };

  // Excuse path: only a `no_hallucinated_regulations` failure can be excused,
  // and only when the text actually references allowlisted external standards
  // AND passes verify once those mentions are neutralised. Anything else is a
  // real failure and goes down the normal repair path.
  if (first.failed !== 'no_hallucinated_regulations') {
    return { verify: first, externalRefs: [] };
  }
  if (externalRefs.length === 0) return { verify: first, externalRefs: [] };

  const stripped = stripExternalStandards(input.text);
  const second = rawVerify(input, stripped);
  if (!second.ok) return { verify: second, externalRefs: [] };

  // Passed thanks to the allowlist → warned pass, refs surfaced to the caller.
  return {
    verify: {
      ...second,
      checks: { ...second.checks, no_hallucinated_regulations: 'warn' },
      warnings: [
        ...(second.warnings ?? []),
        {
          check: 'no_hallucinated_regulations',
          reason: `Externe Standards referenziert (nicht in der Wissensbasis): ${externalRefs.join(', ')}.`,
        },
      ],
    },
    externalRefs,
  };
}
