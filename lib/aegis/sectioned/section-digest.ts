import { callStructured } from '../client';
import { extractCitations } from '../digest';
import { intEnv } from '../env';
import { MODEL_IDS, type ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';

/**
 * Per-section digest (epic F10: "Digests folgen dem Muster aus digest.ts inkl.
 * Citation-Firewall"). After a section finishes, a small Haiku call extracts a
 * structured summary that every FOLLOWING section receives — cross-section
 * consistency without replaying full section texts.
 *
 * Citation firewall: any [R-...] token in the digest that does not appear in
 * the section's actual text is stripped (a digest must never fabricate
 * grounding). Fail-open: a digest failure degrades to an empty digest — it
 * must never fail the section or the job.
 */

export type SectionDigest = {
  /** Key claims made by the section (with their [R-...] citations, firewalled). */
  claims: string[];
  /** Regulation short names the section actually cited. */
  citedRegs: string[];
  /** Terms the section defined (canonical wording for later sections). */
  definedTerms: string[];
  /** Forward references ("wird in Abschnitt X vertieft") to honour later. */
  openReferences: string[];
};

export const EMPTY_SECTION_DIGEST: SectionDigest = {
  claims: [],
  citedRegs: [],
  definedTerms: [],
  openReferences: [],
};

const DIGEST_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: { type: 'array', items: { type: 'string' } },
    citedRegs: { type: 'array', items: { type: 'string' } },
    definedTerms: { type: 'array', items: { type: 'string' } },
    openReferences: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims', 'citedRegs', 'definedTerms', 'openReferences'],
};

const DIGEST_SYSTEM =
  'Extract a structured digest of this report section. claims: the 3-8 load-bearing ' +
  'statements, each keeping its [R-...] citation tokens verbatim where present. ' +
  'citedRegs: regulation short names actually cited. definedTerms: terms the section ' +
  'defines or canonicalises. openReferences: forward references to other sections. ' +
  'Copy wording from the section — do not invent content or citations.';

const CITATION_RE = /\[R-[A-Z0-9]+-[A-Z0-9-]+\]/g;

/** Strip [R-...] tokens that are not present in the section text (firewall). */
export function firewallSectionDigest(
  digest: SectionDigest,
  sectionText: string,
): { digest: SectionDigest; fabricated: string[] } {
  const allowed = extractCitations(sectionText);
  const fabricated = new Set<string>();
  const clean = (items: string[]): string[] =>
    items.map((item) => {
      let out = item;
      for (const tok of item.match(CITATION_RE) ?? []) {
        if (!allowed.has(tok)) {
          fabricated.add(tok);
          out = out.replaceAll(tok, '').replace(/\s{2,}/g, ' ').trim();
        }
      }
      return out;
    });
  return {
    digest: {
      claims: clean(digest.claims),
      citedRegs: digest.citedRegs,
      definedTerms: clean(digest.definedTerms),
      openReferences: clean(digest.openReferences),
    },
    fabricated: [...fabricated],
  };
}

export async function generateSectionDigest(
  sectionText: string,
  deps: {
    call?: typeof callStructured;
    onUsage?: (model: ModelId, usage: ClaudeUsage) => void;
  } = {},
): Promise<SectionDigest> {
  const call = deps.call ?? callStructured;
  try {
    const { value, usage } = await call<SectionDigest>({
      model: MODEL_IDS.haiku,
      system: DIGEST_SYSTEM,
      prompt: sectionText.slice(0, intEnv('AEGIS_SECTION_DIGEST_MAX_CHARS', 24_000)),
      schema: DIGEST_JSON_SCHEMA,
      maxTokens: 1024,
    });
    deps.onUsage?.(MODEL_IDS.haiku, usage);
    const { digest, fabricated } = firewallSectionDigest(
      {
        claims: value.claims ?? [],
        citedRegs: value.citedRegs ?? [],
        definedTerms: value.definedTerms ?? [],
        openReferences: value.openReferences ?? [],
      },
      sectionText,
    );
    if (fabricated.length > 0) {
      console.error(
        JSON.stringify({
          event: 'aegis_section_digest_fabricated_citation',
          level: 'warn',
          fabricated,
        }),
      );
    }
    return digest;
  } catch (err) {
    // Fail-open (iron rule): a digest failure must never fail the section.
    console.error(
      JSON.stringify({
        event: 'aegis_section_digest_failed',
        level: 'warn',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return EMPTY_SECTION_DIGEST;
  }
}
