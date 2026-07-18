import { describe, expect, it } from 'vitest';
import {
  SOFT_CHECKS,
  isSoftCheck,
  verifyResponse,
  warnedResult,
  type VerifyInput,
} from '../verify';

function input(text: string, opts: Partial<Omit<VerifyInput, 'text'>> = {}): VerifyInput {
  return {
    text,
    allowedIds: opts.allowedIds ?? new Set<string>(),
    toolsCalled: opts.toolsCalled ?? 0,
    toolsCalledNames: opts.toolsCalledNames,
    language: opts.language ?? 'de',
  };
}

// A valid, KB-resolving citation used to GROUND fixtures that exist to isolate a
// DIFFERENT check (no_hallucinated / language / no_false_ignorance). Without it
// the (correct) `unsupported_regulatory_claim` hard check — which runs before
// those — fires first on an uncited regulation mention. Appending a real
// citation keeps each test exercising its intended check.
const GROUND_CIT = ' [R-AIACT-001]';
const GROUND_IDS = new Set(['R-AIACT-001']);

// ───────────────────────── non_empty_response ─────────────────────────

describe('verifyResponse — non_empty_response', () => {
  it('fails on empty text', () => {
    const result = verifyResponse(input(''));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('non_empty_response');
  });

  it('fails on whitespace-only text', () => {
    const result = verifyResponse(input('   \n\n   '));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('non_empty_response');
  });

  it('fails on 9-character text', () => {
    const result = verifyResponse(input('123456789'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('non_empty_response');
  });

  it('passes on exactly 10 chars (when other checks pass)', () => {
    const result = verifyResponse(input('1234567890'));
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────── citation_coverage ─────────────────────────

describe('verifyResponse — citation_coverage', () => {
  it('fails when Art. ref has no [R-...] in same paragraph', () => {
    const result = verifyResponse(
      input('Art. 5 enthält die Verbote der EU AI Act-Verordnung in voller Länge.'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('citation_coverage');
  });

  it('fails when § reference is uncited', () => {
    const result = verifyResponse(
      input('§ 8 BDSG regelt Voraussetzungen der Verarbeitung von Beschäftigtendaten.'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('citation_coverage');
  });

  it('passes when Art. ref is paired with [R-...] in same paragraph', () => {
    const result = verifyResponse(
      input('Art. 5 [R-AIACT-005] enthält die Verbote der EU AI Act-Verordnung.', {
        allowedIds: new Set(['R-AIACT-005']),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when cited ID is not in allowedIds (hallucinated citation)', () => {
    const result = verifyResponse(
      input('Art. 5 [R-FAKE-999] ist relevant für die DORA-Verordnung in der EU.', {
        allowedIds: new Set(['R-AIACT-005']),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('citation_coverage');
  });

  it('passes when text has no article references at all', () => {
    const result = verifyResponse(
      input('Die DORA-Verordnung gilt für alle Finanzinstitute und ist bindend.' + GROUND_CIT, {
        allowedIds: GROUND_IDS,
      }),
    );
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────── no_hallucinated_regulations ─────────────────────────

describe('verifyResponse — no_hallucinated_regulations', () => {
  it('fails when an unknown ISO standard is cited', () => {
    const result = verifyResponse(
      input(
        'Die ISO 99999 ist eine neue Norm und wird für viele Banken nicht relevant sein.',
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('no_hallucinated_regulations');
  });

  it('passes for valid regulation names (DORA, GDPR, ISO 42001, NIST AI RMF)', () => {
    expect(
      verifyResponse(
        input('Die DORA-Verordnung gilt für alle und ist verpflichtend für Banken.' + GROUND_CIT, {
          allowedIds: GROUND_IDS,
        }),
      ).ok,
    ).toBe(true);
    expect(
      verifyResponse(
        input('Die GDPR ist für die Verarbeitung personenbezogener Daten anwendbar.' + GROUND_CIT, {
          allowedIds: GROUND_IDS,
        }),
      ).ok,
    ).toBe(true);
    expect(
      verifyResponse(
        input('ISO 42001 ist ein Standard und gilt für alle KI-Management-Systeme.' + GROUND_CIT, {
          allowedIds: GROUND_IDS,
        }),
      ).ok,
    ).toBe(true);
  });

  it('passes for "Product Liability" (matches Directive shortname leniently)', () => {
    const result = verifyResponse(
      input(
        'Die Product Liability Directive ist relevant für KI-Systeme und für die EU.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  // ── Entry-ID handling: citations must not be parsed as regulation names ──

  it('passes for bracketed KB citation [R-FINMA-001] (not a regulation name)', () => {
    const result = verifyResponse(
      input(
        'Das System [R-FINMA-001] ist relevant für alle Banken in der Schweiz.',
        { allowedIds: new Set(['R-FINMA-001']) },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for bracketed [R-FINMARS2023-GOV] (entry ID with digit-prefix, not regulation)', () => {
    // Real KB id whose prefix segment contains digits (FINMARS2023) — must not be
    // mistaken for a regulation name, and resolves in KB.byId (E(ii)).
    const result = verifyResponse(
      input(
        'Die Anforderung [R-FINMARS2023-GOV] gilt für alle Banken in der Schweiz.',
        { allowedIds: new Set(['R-FINMARS2023-GOV']) },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when a cited ID is in allowedIds but does not resolve in KB.byId (E-ii)', () => {
    // Defense-in-depth: even if a spurious ID slipped into allowedIds, an ID that
    // is not a real KB entry must be rejected.
    const result = verifyResponse(
      input('Die Anforderung [R-AIACT-999999] ist relevant für alle Anbieter in der EU.', {
        allowedIds: new Set(['R-AIACT-999999']),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('citation_coverage');
  });

  it('passes for bracketed [R-NIST-GOV] (entry ID, not regulation)', () => {
    const result = verifyResponse(
      input(
        'Die Anforderung [R-NIST-GOV] gilt für alle Organisationen in den USA.',
        { allowedIds: new Set(['R-NIST-GOV']) },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for bracketed [R-MARISK-435] (entry ID, not regulation)', () => {
    const result = verifyResponse(
      input(
        'Die Anforderung [R-MARISK-435] gilt für alle Banken in Deutschland.',
        { allowedIds: new Set(['R-MARISK-435']) },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for known regulation "FINMA 08/2024"', () => {
    const result = verifyResponse(
      input(
        'Die FINMA 08/2024 ist die aktuelle Aufsichtsmitteilung und gilt für alle Banken.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  // ── German compound words: known regulation as prefix ──

  it('passes for German compound "FINMA-Standards" (base FINMA is known)', () => {
    const result = verifyResponse(
      input(
        'Die FINMA-Standards sind für alle Banken in der Schweiz verbindlich.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for German compound "DORA-Anforderungen"', () => {
    const result = verifyResponse(
      input(
        'Die DORA-Anforderungen gelten für alle Finanzinstitute und sind verbindlich.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for German compound "NIS2-konform"', () => {
    const result = verifyResponse(
      input(
        'Das System ist NIS2-konform und damit für die Aufsicht zugelassen.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for German compound "GDPR-Compliance"', () => {
    const result = verifyResponse(
      input(
        'Die GDPR-Compliance ist für die Verarbeitung personenbezogener Daten relevant.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for "EU-AI-Act-konform" (hyphenated form not captured by regex)', () => {
    // The regex requires spaces in "EU AI Act" so the hyphenated form
    // produces no regex match; the check passes silently.
    const result = verifyResponse(
      input(
        'Das System ist EU-AI-Act-konform und für die Praxis relevant geprüft.',
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for German compound "FINMA-Verordnung" (base FINMA is known)', () => {
    // Under the German-compound policy, any hyphenated form with a known
    // regulation prefix passes — including descriptive compounds where the
    // suffix is generic prose like "Verordnung", "Standards", "Richtlinie".
    const result = verifyResponse(
      input(
        'Die FINMA-Verordnung ist eine Regelung und für alle Banken relevant.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('fails a known compound paired with an INVENTED act number (2025/99)', () => {
    // The KNOWN_EU_ACT_NUMBERS check: a legal-act keyword followed by an
    // Official Journal designator that no KB regulation carries is the
    // classic invented-regulation shape the name whitelist cannot see.
    const result = verifyResponse(
      input(
        'Die FINMA-Verordnung 2025/99 ist eine Regelung und für alle Banken relevant.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('no_hallucinated_regulations');
  });

  it('passes real Official Journal designators of KB acts', () => {
    const result = verifyResponse(
      input(
        'Die Verordnung (EU) 2022/2554 (DORA) verlangt einen IKT-Risikomanagementrahmen.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes act numbers quoted from curated KB text (KB-derived allowlist)', () => {
    // R-AIACT-002 bodyDe cites Verordnung (EU) 2018/1725 and Richtlinie (EU)
    // 2016/680 — quoting a curated KB passage must never fail verify.
    const result = verifyResponse(
      input(
        'Der AI Act lässt die Verordnung (EU) 2018/1725 und die Richtlinie (EU) 2016/680 unberührt.' + GROUND_CIT,
        { allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });
});

// ───────────────────────── language_consistency ─────────────────────────

describe('verifyResponse — language_consistency', () => {
  it('passes when DE response is requested as DE', () => {
    const result = verifyResponse(
      input(
        'Die DORA-Anforderungen sind nicht für alle Banken anwendbar und werden für die Aufsicht relevant.' + GROUND_CIT,
        { language: 'de', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes when EN response is requested as EN', () => {
    const result = verifyResponse(
      input(
        'The DORA requirements are not applicable to all banks and are relevant to the supervisor.' + GROUND_CIT,
        { language: 'en', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when DE response is returned for EN request', () => {
    const result = verifyResponse(
      input(
        'Die DORA-Anforderungen sind nicht für alle Banken anwendbar und werden für die Aufsicht relevant.' + GROUND_CIT,
        { language: 'en', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('language_consistency');
  });

  it('fails when EN response is returned for DE request', () => {
    const result = verifyResponse(
      input(
        'The DORA requirements are not applicable to all banks and are relevant to the supervisor.' + GROUND_CIT,
        { language: 'de', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('language_consistency');
  });
});

// ───────────────────────── no_false_ignorance ─────────────────────────

describe('verifyResponse — no_false_ignorance', () => {
  it('fails when tools were called but response claims ignorance (DE)', () => {
    const result = verifyResponse(
      input(
        'Dies wird von der aktuellen Wissensbasis nicht abgedeckt. Bitte präzisieren Sie die Frage.',
        { toolsCalled: 2 },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('no_false_ignorance');
  });

  it('fails when tools were called but response claims ignorance (EN)', () => {
    const result = verifyResponse(
      input(
        'This is not covered by the current knowledge base. Please refine the question and ask again.',
        { toolsCalled: 2, language: 'en' },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('no_false_ignorance');
  });

  it('passes when no tools were called and response legitimately claims ignorance', () => {
    const result = verifyResponse(
      input(
        'Dies wird von der aktuellen Wissensbasis nicht abgedeckt. Bitte präzisieren Sie die Frage.',
        { toolsCalled: 0 },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes when tools were called and no ignorance is claimed', () => {
    const result = verifyResponse(
      input(
        'Die DORA-Verordnung gilt für alle Banken und ist seit 2025 verpflichtend.' + GROUND_CIT,
        { toolsCalled: 3, allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  // ── read_source fallback handling ──

  it('fails with read_source feedback when ignorance is claimed without trying read_source', () => {
    const result = verifyResponse(
      input(
        'Dies wird von der aktuellen Wissensbasis nicht abgedeckt. Bitte präzisieren Sie die Frage.',
        { toolsCalled: 2, toolsCalledNames: ['search_kb', 'get_crosswalk'] },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed).toBe('no_false_ignorance');
      expect(result.feedback.toLowerCase()).toContain('read_source');
    }
  });

  it('still fails when ignorance is claimed even after read_source was called (different feedback)', () => {
    const result = verifyResponse(
      input(
        'Dies wird von der aktuellen Wissensbasis nicht abgedeckt. Bitte präzisieren Sie die Frage.',
        {
          toolsCalled: 3,
          toolsCalledNames: ['search_kb', 'get_crosswalk', 'read_source'],
        },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failed).toBe('no_false_ignorance');
      // Feedback should NOT mention read_source again — the agent has already tried it.
      expect(result.feedback.toLowerCase()).not.toContain('read_source');
    }
  });
});

// ───────────────────────── tiered verify (3.2) ─────────────────────────

describe('tiered verification (3.2)', () => {
  it('classifies the hard/soft split correctly', () => {
    expect(isSoftCheck('language_consistency')).toBe(true);
    expect(isSoftCheck('no_false_ignorance')).toBe(true);
    expect(isSoftCheck('citation_coverage')).toBe(false);
    expect(isSoftCheck('no_hallucinated_regulations')).toBe(false);
    expect(isSoftCheck('non_empty_response')).toBe(false);
    expect(SOFT_CHECKS.size).toBe(2);
  });

  it('warnedResult marks the failed check and carries the warning', () => {
    const r = warnedResult('language_consistency', 'language mismatch');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checks.language_consistency).toBe('warn');
      expect(r.checks.citation_coverage).toBe('pass');
      expect(r.warnings).toEqual([
        { check: 'language_consistency', reason: 'language mismatch' },
      ]);
    }
  });
});

// ───────────────── unsupported_regulatory_claim (blind-spot fix) ─────────────────

describe('verifyResponse — unsupported_regulatory_claim', () => {
  it('fails an ungrounded regulatory answer (names a regulation, zero citations)', () => {
    const result = verifyResponse(
      input(
        'DORA is the Digital Operational Resilience Act. Binding level: mandatory. ' +
          'It applies to all financial entities in the EU and covers ICT risk management.',
        { language: 'en' },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe('unsupported_regulatory_claim');
  });

  it('passes a clarification reply that names regulations but asserts nothing (marker + ?)', () => {
    const result = verifyResponse(
      input(
        'I need more information to answer this. Which regulation are you asking about — ' +
          'the EU AI Act, DORA, or another framework? What does your system do?',
        { language: 'en' },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes a refusal using the canonical ignorance phrase (no citations)', () => {
    const result = verifyResponse(
      input(
        'This is not covered by the current knowledge base. Please consult the official text.',
        { language: 'en' },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes a properly grounded answer (regulation named + valid citation)', () => {
    const result = verifyResponse(
      input(
        'The DORA framework requires ICT risk management [R-AIACT-001] for financial entities.',
        { language: 'en', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('passes a purely conversational reply with no regulatory content', () => {
    const result = verifyResponse(
      input('Hello! I am AEGIS, the RegCompass compliance advisor. How can I help today?', {
        language: 'en',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('partially grounded: ≥1 valid citation + an extra uncited reg mention → passes (no over-fire)', () => {
    const result = verifyResponse(
      input(
        'The DORA framework requires ICT risk management [R-AIACT-001]. NIS2 also applies to ' +
          'network security for essential entities.',
        { language: 'en', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('regression: a grounded answer with an article ref passes BOTH citation_coverage and the new check', () => {
    const result = verifyResponse(
      input(
        'Art. 5 [R-AIACT-001] sets out the prohibited practices under the EU AI Act for all providers.',
        { language: 'en', allowedIds: GROUND_IDS },
      ),
    );
    expect(result.ok).toBe(true);
  });
});
