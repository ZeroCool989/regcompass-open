import { z } from 'zod';
import { KB } from '@/lib/kb';
import { callStructured } from '../client';
import { intEnv } from '../env';
import { MODEL_IDS } from '../types';
import type { ClaudeUsage } from '../context/cost';

/**
 * Plan pass — one Sonnet call that decomposes a SECTIONED deliverable request
 * into a validated outline: per-section scope contracts plus a global shared
 * vocabulary. The plan is the job's source of truth: the executor generates
 * sections strictly in plan order, each section call receives the full plan +
 * its own scope contract + the vocabulary + the digests of finished sections.
 *
 * Validation is DETERMINISTIC (Zod, no model in the loop): section count cap,
 * per-section token cap, no covers[] keyword overlap between sections, and
 * every section either KB-anchored (>= 1 kbDomain) or explicitly grounded=false
 * (advisory content — relaxed verify profile downstream, labelled in output).
 *
 * A plan that fails validation throws `PlanValidationError`; the CALLER decides
 * the fallback (the wired pipeline silently degrades to SINGLE_PASS — per the
 * iron rule, no internal failure ever reaches the user).
 */

export const MAX_PLAN_SECTIONS = 20;

const sectionTokenCap = (): number => intEnv('AEGIS_SECTION_MAX_TOKENS', 4096);

/**
 * Cosmetic caps are CLAMPED, never rejected (E2E findings 2026-07-17/18: live
 * Sonnet plans trip length caps the prompt can't reliably enforce, and every
 * rejection silently degrades the job to single-pass). Only the pinned
 * structural contracts stay hard: section count, covers disjointness,
 * grounded ⇒ kbDomain, and the enums.
 */
const clampedString = (min: number, max: number) =>
  z.string().min(min).transform((s) => s.slice(0, max));

export const PlanSection = z.object({
  title: clampedString(3, 200),
  /**
   * Topics this section OWNS — keyword list, disjoint across sections.
   * Over-long lists are CLAMPED, not rejected: live Sonnet plans for real
   * prompts exceed keyword caps routinely (E2E finding 2026-07-17), and a
   * hard failure here silently degrades the whole job to single-pass. A
   * clamped subset of disjoint sets stays disjoint, so the pinned
   * disjointness contract below is unaffected.
   */
  covers: z
    .array(clampedString(2, 80))
    .min(1)
    .transform((arr) => arr.slice(0, 12)),
  /** Topics explicitly out of scope here (owned by another section). */
  coversNot: z
    .array(clampedString(0, 80))
    .default([])
    .transform((arr) => arr.slice(0, 12)),
  /** KB regulation short names this section is grounded in. */
  kbDomains: z
    .array(clampedString(0, 60))
    .default([])
    .transform((arr) => arr.slice(0, 8)),
  /**
   * `false` = advisory content with no KB anchor (licence choice, SSO setup…):
   * relaxed verify profile, labelled as Beratungsinhalt in the assembled output.
   */
  grounded: z.boolean(),
  outputShape: z.enum(['prose', 'table']),
  estTokens: z
    .number()
    .int()
    .transform((n) => Math.min(Math.max(n, 200), sectionTokenCap())),
});
export type PlanSection = z.infer<typeof PlanSection>;

export const PlanVocab = z.object({
  /** Canonical entity names (company, product, system names) used verbatim. */
  entities: z.array(clampedString(0, 120)).default([]).transform((a) => a.slice(0, 20)),
  jurisdictions: z.array(clampedString(0, 60)).default([]).transform((a) => a.slice(0, 10)),
  /** Terminology decisions, e.g. "Auslagerung, nicht Outsourcing". */
  terminology: z.array(clampedString(0, 160)).default([]).transform((a) => a.slice(0, 20)),
  citationStyle: clampedString(0, 200).default('[R-...] inline nach jeder gestützten Aussage'),
});
export type PlanVocab = z.infer<typeof PlanVocab>;

export const AegisPlan = z
  .object({
    sections: z.array(PlanSection).min(1).max(MAX_PLAN_SECTIONS),
    vocab: PlanVocab,
  })
  .superRefine((plan, ctx) => {
    const owner = new Map<string, number>(); // normalized keyword → section index
    plan.sections.forEach((section, i) => {
      // Scope contract: grounded sections need at least one KB anchor.
      if (section.grounded && section.kbDomains.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'kbDomains'],
          message: `Section "${section.title}" is grounded but names no kbDomain — set grounded=false or add a domain.`,
        });
      }
      // Disjoint ownership: the same covers[] keyword in two sections produces
      // duplicate content downstream, so it is rejected here, deterministically.
      for (const keyword of section.covers) {
        const norm = keyword.toLowerCase().trim();
        const prev = owner.get(norm);
        if (prev !== undefined && prev !== i) {
          ctx.addIssue({
            code: 'custom',
            path: ['sections', i, 'covers'],
            message: `covers keyword "${keyword}" already owned by section ${prev + 1} ("${plan.sections[prev].title}").`,
          });
        } else {
          owner.set(norm, i);
        }
      }
    });
  });
export type AegisPlan = z.infer<typeof AegisPlan>;

export class PlanValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`Plan failed deterministic validation: ${issues.map((i) => i.message).join(' | ')}`);
    this.name = 'PlanValidationError';
  }
}

// ───────────────────── Ownership normalization (pre-validation) ─────────────────────

/** Structural schema WITHOUT the cross-section refinements — normalization input. */
const AegisPlanShape = z.object({
  sections: z.array(PlanSection).min(1).max(MAX_PLAN_SECTIONS),
  vocab: PlanVocab,
});

export type PlanNormalization = {
  plan: z.infer<typeof AegisPlanShape>;
  /** Sections dropped because every covers keyword was already owned. */
  dropped: Array<{ index: number; title: string }>;
  /** Count of later duplicate keyword claims removed. */
  dedupedKeywords: number;
};

/**
 * Deterministic ownership dedup (epic resolution 2026-07-18): the pinned
 * covers[] disjointness rule is enforced BY CONSTRUCTION instead of trusting
 * the model. Walking sections in plan order, each normalized keyword belongs
 * to the FIRST section that claims it; later claims are dropped. A section
 * whose covers[] empties out is merged away: its title becomes a covers
 * keyword of the previous kept section when unowned (scope preserved),
 * otherwise the section is dropped outright — its topics are owned elsewhere.
 * The refined `AegisPlan` validator still runs afterwards and remains the
 * authoritative contract; normalization makes real Sonnet plans satisfy it
 * deterministically.
 */
export function normalizePlanOwnership(
  plan: z.infer<typeof AegisPlanShape>,
): PlanNormalization {
  const owned = new Set<string>();
  const norm = (s: string): string => s.toLowerCase().trim();
  const kept: typeof plan.sections = [];
  const dropped: PlanNormalization['dropped'] = [];
  let dedupedKeywords = 0;

  plan.sections.forEach((section, index) => {
    const covers: string[] = [];
    for (const keyword of section.covers) {
      const key = norm(keyword);
      if (!key || owned.has(key)) {
        dedupedKeywords++;
        continue;
      }
      owned.add(key);
      covers.push(keyword);
    }
    if (covers.length > 0) {
      kept.push({ ...section, covers });
      return;
    }
    // Empty after dedup → merge the scope into the previous kept section via
    // the title keyword (when unowned), then drop the section.
    dropped.push({ index, title: section.title });
    const titleKey = norm(section.title).slice(0, 80);
    const prev = kept[kept.length - 1];
    if (prev && titleKey && !owned.has(titleKey) && prev.covers.length < 12) {
      owned.add(titleKey);
      prev.covers.push(section.title.slice(0, 80));
    }
  });

  return {
    plan: { sections: kept, vocab: plan.vocab },
    dropped,
    dedupedKeywords,
  };
}

// ───────────────────────── Structured-output schema ─────────────────────────

/** JSON Schema mirror of AegisPlan for the structured-output call (simple types only). */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          covers: { type: 'array', items: { type: 'string' } },
          coversNot: { type: 'array', items: { type: 'string' } },
          kbDomains: { type: 'array', items: { type: 'string' } },
          grounded: { type: 'boolean' },
          outputShape: { type: 'string', enum: ['prose', 'table'] },
          estTokens: { type: 'integer' },
        },
        required: ['title', 'covers', 'coversNot', 'kbDomains', 'grounded', 'outputShape', 'estTokens'],
      },
    },
    vocab: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entities: { type: 'array', items: { type: 'string' } },
        jurisdictions: { type: 'array', items: { type: 'string' } },
        terminology: { type: 'array', items: { type: 'string' } },
        citationStyle: { type: 'string' },
      },
      required: ['entities', 'jurisdictions', 'terminology', 'citationStyle'],
    },
  },
  required: ['sections', 'vocab'],
};

// ───────────────────────── Prompt ─────────────────────────

function planSystem(language: 'de' | 'en'): string {
  const kbList = KB.regulations.map((r) => r.shortName).join(', ');
  const langLine =
    language === 'de'
      ? 'Alle title/covers/coversNot/terminology-Werte auf DEUTSCH.'
      : 'All title/covers/coversNot/terminology values in ENGLISH.';
  return (
    'You are the planning stage of the RegCompass AEGIS agent. Decompose the ' +
    "user's deliverable request into a section outline with scope contracts.\n\n" +
    'Rules:\n' +
    `- At most ${MAX_PLAN_SECTIONS} sections; merge related asks rather than exceeding the cap. ` +
    'Follow the structure the user gave (numbered sections) where present; a requested ' +
    'catalogue/register becomes its own section with outputShape "table".\n' +
    `- kbDomains entries MUST come from this list (the knowledge base): ${kbList}.\n` +
    '- A section whose content has NO anchor in those regulations (e.g. open-source licence ' +
    'choice, SSO/IAM setup, repository hygiene, operating model) MUST set grounded=false and ' +
    'kbDomains=[] — it will be labelled as advisory content. A grounded section names >= 1 kbDomain.\n' +
    '- covers[] keywords define EXCLUSIVE ownership: no keyword may appear in two sections. ' +
    'Use coversNot[] to point overlapping topics at the owning section. ' +
    'Per section: at most 12 covers keywords, 12 coversNot entries, 8 kbDomains.\n' +
    `- estTokens per section: realistic output size, 200–${sectionTokenCap()}.\n` +
    '- vocab: canonical entity names, jurisdictions, terminology decisions ' +
    '(e.g. "Auslagerung, nicht Outsourcing") and the citation style — every section will ' +
    `follow it. ${langLine}`
  );
}

// ───────────────────────── Entry point ─────────────────────────

export type GeneratePlanResult = {
  plan: AegisPlan;
  usage: ClaudeUsage;
};

/**
 * Run the plan pass. The model call is injected (defaults to the real
 * structured Sonnet call) so tests can stub it. Throws `PlanValidationError`
 * when the returned outline fails the deterministic checks; upstream transport
 * errors propagate as AegisError from callStructured.
 */
export async function generatePlan(
  message: string,
  language: 'de' | 'en',
  // The request's frozen provider selection — the plan-pass dispatches on the
  // same brain as the rest of the run, so a dev AEGIS_BRAIN cannot split it off.
  provider: 'anthropic' | 'gemini' | undefined,
  deps: { call?: typeof callStructured } = {},
): Promise<GeneratePlanResult> {
  const call = deps.call ?? callStructured;
  const { value, usage } = await call<unknown>({
    model: MODEL_IDS.sonnet,
    system: planSystem(language),
    prompt: message,
    schema: PLAN_JSON_SCHEMA,
    maxTokens: intEnv('AEGIS_PLAN_MAX_TOKENS', 3000),
    provider,
  });
  // Structural parse → deterministic ownership normalization → authoritative
  // refined validation (disjointness now holds by construction).
  const shaped = AegisPlanShape.safeParse(value);
  if (!shaped.success) {
    throw new PlanValidationError(shaped.error.issues);
  }
  const normalized = normalizePlanOwnership(shaped.data);
  if (normalized.dropped.length > 0 || normalized.dedupedKeywords > 0) {
    console.warn(
      JSON.stringify({
        event: 'aegis_plan_ownership_normalized',
        level: 'warn',
        dedupedKeywords: normalized.dedupedKeywords,
        droppedSections: normalized.dropped,
      }),
    );
  }
  const parsed = AegisPlan.safeParse(normalized.plan);
  if (!parsed.success) {
    throw new PlanValidationError(parsed.error.issues);
  }
  return { plan: parsed.data, usage };
}
