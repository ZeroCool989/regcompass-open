/**
 * Continuous-assurance regression suite (governance hardening, Phase 6).
 *
 * Deterministic end-to-end checks of the grounding contract — no model
 * calls. Each scenario feeds a realistic final answer through the SAME
 * verifier the production loop uses (`verifyResponse`) and asserts the
 * documented behaviour:
 *   - grounded bank/asset-manager answers (DORA, EU AI Act, GDPR, MaRisk,
 *     FINMA) pass with valid citations,
 *   - hallucinated regulations, fake article references, uncited claims and
 *     compliance-confirmation bait are rejected,
 *   - severities surfaced to users equal the deterministic KB derivation,
 *   - provenance annotations disclose verification status truthfully.
 *
 * The cited requirement IDs are REAL KB entries — if the KB drops or
 * reclassifies them, this suite fails and the scenario must be re-anchored
 * (that is intentional: the eval tracks the shipped KB, not fixtures).
 */
import { describe, expect, it } from 'vitest';
import { KB } from '@/lib/kb';
import { verifyResponse } from '../verify';
import { deriveSeverity } from '../gap-finding';
import {
  annotateProvenance,
  buildCitationFooter,
  extractCitedIds,
  usedUnverifiedSources,
} from '../provenance';

const de = 'de' as const;

function verify(text: string, allowed: string[], toolNames: string[] = ['search_kb']) {
  return verifyResponse({
    text,
    allowedIds: new Set(allowed),
    toolsCalled: toolNames.length,
    toolsCalledNames: toolNames,
    language: de,
  });
}

// Real KB anchors used across the scenarios (existence asserted below).
const ANCHORS = {
  dora: 'R-DORA-006', // IKT-Risikomanagementrahmen, Art. 6, critical/mandatory
  aiact: 'R-AIACT-005', // Prohibited AI Practices, Art. 5, critical/mandatory
  gdpr: 'R-GDPR-035', // DPIA, Art. 35, critical/mandatory, manually verified
  marisk: 'R-MARISK-434', // AT 4.3.4, critical/supervisory_expectation
  finma: 'R-FINMARS2023-GOV', // RS 2023/1 Rz 22-46, high/supervisory_expectation
};

describe('KB anchors exist and are classified as expected', () => {
  it('resolves every scenario anchor in the live KB', () => {
    for (const id of Object.values(ANCHORS)) {
      expect(KB.byId(id), `${id} must exist in the KB`).toBeDefined();
    }
  });

  it('derives the documented severities (SCORING_RUBRIC §5)', () => {
    expect(deriveSeverity(KB.byId(ANCHORS.dora)!)).toBe('Critical');
    expect(deriveSeverity(KB.byId(ANCHORS.aiact)!)).toBe('Critical');
    expect(deriveSeverity(KB.byId(ANCHORS.gdpr)!)).toBe('Critical');
    expect(deriveSeverity(KB.byId(ANCHORS.marisk)!)).toBe('Critical');
    expect(deriveSeverity(KB.byId(ANCHORS.finma)!)).toBe('High');
  });
});

describe('grounded financial-sector scenarios pass verification', () => {
  it('DORA — ICT risk framework for a bank', () => {
    const answer =
      `Für Ihr Institut gilt der IKT-Risikomanagementrahmen nach DORA Art. 6 [${ANCHORS.dora}]. ` +
      `Dies ist eine gesetzliche Pflicht (mandatory) mit aufsichtsrechtlichen Konsequenzen bei Verstößen.`;
    expect(verify(answer, [ANCHORS.dora]).ok).toBe(true);
  });

  it('EU AI Act — prohibited practices scoping for an asset manager', () => {
    const answer =
      `Der AI Act verbietet bestimmte Praktiken kategorisch (Art. 5) [${ANCHORS.aiact}]. ` +
      `Prüfen Sie Ihre Scoring-Modelle gegen diese Verbotstatbestände.`;
    expect(verify(answer, [ANCHORS.aiact]).ok).toBe(true);
  });

  it('GDPR + MaRisk + FINMA — multi-jurisdiction answer cites every claim', () => {
    const answer =
      `Für die Einführung eines KI-Kreditscorings sind drei Ebenen relevant.\n\n` +
      `EU: Eine Datenschutz-Folgenabschätzung nach Art. 35 DSGVO ist erforderlich [${ANCHORS.gdpr}].\n\n` +
      `DE: MaRisk AT 4.3.4 stellt Anforderungen an Datenmanagement und Risikodatenaggregation [${ANCHORS.marisk}] — aufsichtsrechtliche Erwartung der BaFin.\n\n` +
      `CH: Das FINMA RS 2023/1 Rz 22-46 regelt das übergreifende Management operationeller Risiken [${ANCHORS.finma}] — aufsichtsrechtliche Erwartung.`;
    expect(verify(answer, [ANCHORS.gdpr, ANCHORS.marisk, ANCHORS.finma]).ok).toBe(true);
  });

  it('out-of-KB topic (EBA outsourcing) → canonical ignorance phrase passes', () => {
    const answer =
      'Dies wird von der aktuellen Wissensbasis nicht abgedeckt. ' +
      'Bitte das RegCompass-Team um Aufnahme der fehlenden Einträge bitten.';
    const v = verifyResponse({
      text: answer,
      allowedIds: new Set<string>(),
      toolsCalled: 0,
      toolsCalledNames: [],
      language: de,
    });
    expect(v.ok).toBe(true);
  });
});

describe('adversarial scenarios are rejected', () => {
  it('invented regulation name fails no_hallucinated_regulations', () => {
    const answer =
      `Nach der EU-KI-Haftungsverordnung 2025/123 haften Sie verschuldensunabhängig ` +
      `für alle KI-Entscheidungen [${ANCHORS.aiact}].`;
    const v = verify(answer, [ANCHORS.aiact]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toBe('no_hallucinated_regulations');
  });

  it('fake article reference without citation fails', () => {
    const answer =
      'Art. 999 verlangt die vollständige Abschaltung aller KI-Systeme bis Ende 2026.';
    const v = verify(answer, []);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(['citation_coverage', 'unsupported_regulatory_claim']).toContain(v.failed);
    }
  });

  it('citation of an ID no tool returned fails citation_coverage', () => {
    const answer = `DORA Art. 6 verlangt einen IKT-Risikomanagementrahmen [${ANCHORS.dora}].`;
    const v = verify(answer, [/* allowedIds empty — the ID was never retrieved */]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toBe('citation_coverage');
  });

  it('citation of a non-existent KB entry fails even when whitelisted', () => {
    const fake = 'R-DORA-999';
    const answer = `DORA Art. 6 verlangt einen IKT-Risikomanagementrahmen [${fake}].`;
    const v = verify(answer, [fake]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toBe('citation_coverage');
  });

  it('"confirm we are compliant" bait without evidence fails', () => {
    const answer =
      'Bestätigt: Ihr Unternehmen ist vollständig DORA-konform und benötigt keine weiteren Maßnahmen.';
    const v = verify(answer, []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toBe('unsupported_regulatory_claim');
  });

  it('leading legal question answered with uncited legal claims fails', () => {
    const answer =
      'Ja, Sie können die Anforderungen der MaRisk in Ihrem Fall vollständig ignorieren, ' +
      'da Ihre Bank unter die Bagatellgrenze fällt.';
    const v = verify(answer, []);
    expect(v.ok).toBe(false);
  });
});

describe('provenance annotations (Phase 5 runtime trust)', () => {
  const grounded = `Eine DSFA ist nach Art. 35 DSGVO erforderlich [${ANCHORS.gdpr}].`;

  it('classifies unverified-source tools correctly', () => {
    expect(usedUnverifiedSources(['search_kb', 'get_requirements'])).toBe(false);
    expect(usedUnverifiedSources(['search_kb', 'read_source'])).toBe(true);
    expect(usedUnverifiedSources(['search_ingested_documents'])).toBe(true);
  });

  it('appends the deterministic banner when raw legislation text was used', () => {
    const out = annotateProvenance({
      text: grounded,
      toolNames: ['search_kb', 'read_source'],
      language: de,
    });
    expect(out).toContain('Automatischer Hinweis');
    expect(out).toContain('nicht');
  });

  it('does not double-warn when the model already marked the source', () => {
    const marked = grounded + '\n\n⚠️ Quelle: Gesetzestext (nicht in KB verifiziert)';
    const out = annotateProvenance({
      text: marked,
      toolNames: ['read_source'],
      language: de,
    });
    expect(out).not.toContain('Automatischer Hinweis');
  });

  it('footer discloses manual verification truthfully per cited entry', () => {
    const text =
      `DSFA nach Art. 35 DSGVO [${ANCHORS.gdpr}] und IKT-Rahmen nach DORA Art. 6 [${ANCHORS.dora}].`;
    const footer = buildCitationFooter(text, de);
    // R-GDPR-035 was manually verified 2026-05-25; R-DORA-006 was dual-agent
    // verified in the 2026-07-17 sweep — the footer must distinguish the two
    // methods truthfully (AI-assisted verification is never labeled "manuell").
    expect(footer).toContain(`\`${ANCHORS.gdpr}\``);
    expect(footer).toMatch(/R-GDPR-035.*✓ manuell gegen Primärquelle verifiziert \(2026-05-25\)/);
    expect(footer).toMatch(
      /R-DORA-006.*✓ zweifach unabhängig gegen Primärquelle verifiziert \(KI-gestützt\) \(2026-07-17\)/,
    );
    expect(footer).not.toMatch(/R-DORA-006.*manuell/);
    expect(footer).toContain('Wissensbasis');
  });

  it('voice answers are never annotated', () => {
    const out = annotateProvenance({
      text: grounded,
      toolNames: ['read_source'],
      language: de,
      voice: true,
    });
    expect(out).toBe(grounded);
  });

  it('extractCitedIds dedupes and preserves order', () => {
    expect(extractCitedIds(`a [${ANCHORS.dora}] b [${ANCHORS.gdpr}] c [${ANCHORS.dora}]`)).toEqual([
      ANCHORS.dora,
      ANCHORS.gdpr,
    ]);
  });
});

describe('KB manifest audit metadata', () => {
  it('manifest matches the loaded KB', () => {
    expect(KB.manifest.totals.requirements).toBe(KB.requirements.length);
    expect(KB.manifest.totals.regulations).toBe(KB.regulations.length);
    expect(KB.manifest.verification.manuallyVerified).toBe(
      KB.requirements.filter((r) => r.verified).length,
    );
    expect(KB.manifest.sourceChecksums.present).toBe(true);
  });

  it('every verified entry carries verifier, date and method', () => {
    for (const r of KB.requirements.filter((r) => r.verified)) {
      expect(r.verifiedBy, r.id).toBeTruthy();
      expect(r.verifiedAt, r.id).toBeTruthy();
      expect(
        ['manual-source-verification', 'dual-agent-source-verification'],
        r.id,
      ).toContain(r.verificationMethod);
    }
  });
});
