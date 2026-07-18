import { z } from 'zod';

/** Jurisdictions matching the Prisma RegulatoryJurisdiction enum. */
export const JURISDICTIONS = ['EU', 'DE', 'CH', 'INTL'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** KB-aligned classification vocabularies (must match lib/kb enums). */
export const RELEVANCE_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export const BINDING_LEVELS = ['mandatory', 'supervisory_expectation', 'best_practice'] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];
export type BindingLevel = (typeof BINDING_LEVELS)[number];

/**
 * A public news item. Every item MUST carry a real source URL — the validator
 * rejects anything without one so the feed can never contain fabricated sources.
 */
export const NewsItemSchema = z.object({
  title: z.string().trim().min(3).max(300),
  summary: z.string().trim().min(10).max(2000),
  /** Relevance for the financial sector / IT compliance / AI compliance. */
  relevance: z.string().trim().min(5).max(1200),
  sourceName: z.string().trim().min(2).max(120),
  sourceUrl: z.string().trim().url(),
  /** ISO date string (YYYY-MM-DD or full ISO); optional. */
  publishedAt: z.string().trim().min(4).max(40).optional(),
  jurisdiction: z.enum(JURISDICTIONS),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
export type NewsItem = z.infer<typeof NewsItemSchema>;

/**
 * An internal KB-update proposal. NEVER applied to the production KB
 * automatically — it is a draft a human must accept.
 */
export const KbSuggestionSchema = z.object({
  sourceName: z.string().trim().min(2).max(120),
  sourceUrl: z.string().trim().url(),
  regulation: z.string().trim().min(2).max(120),
  proposedRequirementId: z.string().trim().max(60).optional(),
  proposedRequirementText: z.string().trim().min(20).max(4000),
  relevanceForFinancialSector: z.enum(RELEVANCE_LEVELS),
  bindingLevel: z.enum(BINDING_LEVELS),
  rationale: z.string().trim().min(10).max(2000),
});
export type KbSuggestion = z.infer<typeof KbSuggestionSchema>;

export const ResearchResultSchema = z.object({
  news: z.array(NewsItemSchema).default([]),
  suggestions: z.array(KbSuggestionSchema).default([]),
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
