/**
 * Deterministic provenance annotations for final AEGIS answers.
 *
 * Prompt instructions ask the model to mark unverified sources itself; this
 * module is the code-level enforcement on top (docs/CLAUDE.md: deterministic
 * validation over prompt engineering):
 *
 *  1. Unverified-source banner — appended whenever the turn actually called a
 *     tool that reads outside the curated KB (`read_source`,
 *     `read_source_passages`, `search_ingested_documents`) and the answer does
 *     not already carry the prompt-mandated ⚠️ source marker. Conservative by
 *     design: calling the tool is enough, even if the final text may not have
 *     used the passage.
 *  2. Citation verification footer — for every KB requirement cited in the
 *     answer, states whether the entry was manually verified against its
 *     primary source or is still machine-extracted, plus the KB audit
 *     snapshot (version, verification coverage) from `KB.manifest`.
 *
 * Applied by the orchestrator (lib/aegis/index.ts) AFTER verifyResponse has
 * accepted the text — the annotations never influence verification, and the
 * annotated text is what gets persisted and streamed (appended as a `token`
 * event, so the client's streamed draft stays intact). Voice turns are left
 * untouched (annotations would be read aloud).
 */
import { KB } from '@/lib/kb';
import { regulationShortName } from './gap-finding';

/** Tools whose results are NOT part of the curated, source-verified KB. */
export const UNVERIFIED_SOURCE_TOOLS = [
  'read_source',
  'read_source_passages',
  'search_ingested_documents',
] as const;

const CITATION_RE = /\[(R-[A-Z0-9]+-[A-Z0-9-]+)\]/g;

/** Model-side markers mandated by the identity prompt (identity.ts). */
const MODEL_SOURCE_MARKER = /⚠️\s*(Quelle|Source):/;

const BANNER = {
  de:
    '\n\n> ⚠️ **Automatischer Hinweis:** Für diese Antwort wurden Quellen ' +
    'außerhalb der kuratierten Wissensbasis herangezogen (Gesetzestext-Volltext ' +
    'oder extern eingespeiste Dokumente). Diese Passagen sind nicht ' +
    'quellenverifiziert — vor Verwendung manuell prüfen.',
  en:
    '\n\n> ⚠️ **Automatic notice:** This answer drew on sources outside the ' +
    'curated knowledge base (raw legislation text or externally ingested ' +
    'documents). Those passages are not source-verified — review manually ' +
    'before use.',
};

export type ProvenanceInput = {
  text: string;
  /** Names of tools actually executed this turn (state.toolCalls names). */
  toolNames: string[];
  language: 'de' | 'en';
  /** Voice answers are spoken — never annotated. */
  voice?: boolean;
};

export function usedUnverifiedSources(toolNames: string[]): boolean {
  return toolNames.some(n => (UNVERIFIED_SOURCE_TOOLS as readonly string[]).includes(n));
}

/** Unique cited requirement IDs in order of first appearance. */
export function extractCitedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITATION_RE)].map(m => m[1]))];
}

export function citationStatusLine(id: string, language: 'de' | 'en'): string | null {
  const req = KB.byId(id);
  if (!req) return null; // verify guarantees resolvability; stay silent if not
  const ref = `${regulationShortName(req.regulation)} ${req.article}`.trim();
  if (req.verified) {
    const when = req.verifiedAt ? ` (${req.verifiedAt})` : '';
    if (req.verificationMethod === 'dual-agent-source-verification') {
      return language === 'de'
        ? `- \`${id}\` ${ref} — ✓ zweifach unabhängig gegen Primärquelle verifiziert (KI-gestützt)${when}`
        : `- \`${id}\` ${ref} — ✓ verified against primary source in two independent passes (AI-assisted)${when}`;
    }
    return language === 'de'
      ? `- \`${id}\` ${ref} — ✓ manuell gegen Primärquelle verifiziert${when}`
      : `- \`${id}\` ${ref} — ✓ manually verified against primary source${when}`;
  }
  return language === 'de'
    ? `- \`${id}\` ${ref} — ⚠ maschinell extrahiert, noch nicht manuell verifiziert`
    : `- \`${id}\` ${ref} — ⚠ machine-extracted, not yet manually verified`;
}

/** KB audit snapshot line for answers and generated reports. */
export function auditSnapshotLine(language: 'de' | 'en'): string {
  const m = KB.manifest;
  return language === 'de'
    ? `Wissensbasis ${m.kbVersion} (Stand ${m.generatedAt}) · ` +
      `${m.totals.requirements} Anforderungen · ${m.verification.manuallyVerified} manuell verifiziert ` +
      `(${m.verification.coveragePct} %) · Quellen-Checksummen: ${m.sourceChecksums.present ? 'verifizierbar' : 'FEHLEN'}`
    : `Knowledge base ${m.kbVersion} (as of ${m.generatedAt}) · ` +
      `${m.totals.requirements} requirements · ${m.verification.manuallyVerified} manually verified ` +
      `(${m.verification.coveragePct}%) · source checksums: ${m.sourceChecksums.present ? 'verifiable' : 'MISSING'}`;
}

export function buildCitationFooter(text: string, language: 'de' | 'en'): string {
  const lines = extractCitedIds(text)
    .map(id => citationStatusLine(id, language))
    .filter((l): l is string => l !== null);
  if (lines.length === 0) return '';
  const heading =
    language === 'de'
      ? '**Zitierte Anforderungen — Verifikationsstatus:**'
      : '**Cited requirements — verification status:**';
  return `\n\n---\n${heading}\n${lines.join('\n')}\n\n_${auditSnapshotLine(language)}_`;
}

/**
 * Append deterministic provenance annotations to a verified final answer.
 * Idempotent per turn (called exactly once by the orchestrator).
 */
export function annotateProvenance(input: ProvenanceInput): string {
  if (input.voice) return input.text;
  let out = input.text;
  if (usedUnverifiedSources(input.toolNames) && !MODEL_SOURCE_MARKER.test(out)) {
    out += BANNER[input.language];
  }
  out += buildCitationFooter(input.text, input.language);
  return out;
}
