import { z } from 'zod';

/**
 * Canonical regulation identifiers shipped with the bundled knowledge base.
 * The `regulation` field is validated as a free string so a custom KB may
 * define its own set; this list documents the shipped canonical values and is
 * the fallback for tool input schemas when a KB exposes no regulations.
 */
export const BUNDLED_REGULATIONS = [
  'EU_AI_ACT', 'DORA', 'GDPR', 'NIS2', 'DSA', 'DATA_ACT',
  'PRODUCT_LIABILITY', 'FINMA_08_2024', 'FINMA_RS_2023_1',
  'FINMA_RS_2018_3', 'REVDSG', 'BDSG', 'BSIG', 'MARISK', 'BAIT',
  'ISO_42001', 'ISO_42005', 'ISO_23894', 'NIST_AI_RMF',
] as const;

/** Canonical category slugs shipped with the bundled knowledge base. */
export const BUNDLED_CATEGORIES = [
  'governance', 'risk-management', 'data', 'transparency', 'security',
  'monitoring', 'documentation', 'third-party', 'rights', 'prohibited-practices',
  'incident-reporting', 'resilience-testing', 'third-party-risk', 'enforcement',
  'cooperation', 'cybersecurity', 'scope', 'definitions', 'classification',
  'conformity', 'conformity-assessment', 'standards', 'registration', 'database',
  'human-oversight', 'record-keeping', 'quality-management', 'post-market-monitoring',
  'provider-obligations', 'deployer-obligations', 'importer-obligations',
  'distributor-obligations', 'authorised-representatives', 'value-chain',
  'corrective-actions', 'market-surveillance', 'codes-of-conduct', 'penalties',
  'fundamental-rights', 'rights-and-remedies', 'innovation-support',
  'gpai-obligations', 'gpai-governance', 'gpai-classification',
  'data-governance', 'testing', 'requirements',
  'transitional-provisions', 'application-timeline',
] as const;

export const Control = z.object({
  id: z.string(),
  action: z.string(),
  description: z.string(),
  standard: z.enum(['ISO_42001', 'ISO_42005', 'ISO_23894', 'NIST_AI_RMF']).optional(),
  standardClause: z.string().optional(),
  nistFunction: z.enum(['GOVERN', 'MAP', 'MEASURE', 'MANAGE']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  complexity: z.enum(['low', 'medium', 'high']),
  implementationSteps: z.array(z.string()).default([]),
  // German translations (populated by scripts/translate-kb.ts)
  actionDe: z.string().optional(),
  descriptionDe: z.string().optional(),
  implementationStepsDe: z.array(z.string()).optional(),
});
export type Control = z.infer<typeof Control>;

export const Requirement = z.object({
  id: z.string(),
  title: z.string(),
  // Regulation identifier. Validated as a non-empty string rather than a fixed
  // enum so a custom (bring-your-own) knowledge base can define its own set;
  // BUNDLED_REGULATIONS below is the canonical list shipped with this repo.
  regulation: z.string().min(1),
  article: z.string(),
  jurisdiction: z.array(z.enum(['EU', 'CH', 'DE', 'INTL'])),
  summary: z.string(),
  body: z.string(),
  // Canonical EU-AI-Act risk tiers (ADR-001): synonyms like 'high',
  // 'unacceptable', 'limited', 'minimal' are rejected — run
  // scripts/kb-migrate-governance.ts to canonicalize legacy data.
  riskTier: z.enum([
    'prohibited', 'high-risk', 'limited-risk', 'minimal-risk',
    'all', 'gpai', 'gpai-systemic'
  ]).optional(),
  tags: z.array(z.string()).default([]),
  sourceUrl: z.string().optional(),
  // Primary source this entry was extracted from; must resolve to a file in
  // docs/source/ (enforced by scripts/validate-kb.ts; waivers documented there).
  sourceFile: z.string().optional(),
  verified: z.boolean().default(false),
  verifiedBy: z.string().optional(),
  verifiedAt: z.string().optional(),
  verificationMethod: z.enum([
    'manual-source-verification', 'primary-source-extraction', 'automated-crosscheck-v1',
    'dual-agent-source-verification'
  ]).optional(),
  verificationVersion: z.string().optional(),
  // Scoring governance (docs/governance/SCORING_RUBRIC.md): who assigned
  // relevanceForFinancialSector/bindingLevel, when, and why.
  scoredBy: z.string().optional(),
  scoredAt: z.string().optional(),
  scoreRationale: z.string().optional(),
  audience: z.array(z.enum([
    'provider', 'deployer', 'authority', 'all',
    'gpai-provider', 'importer', 'distributor', 'authorised-representative',
    'financial-entity', 'ict-third-party-provider'
  ])),
  // Category slug. Validated as a non-empty string (not a fixed enum) so a
  // custom knowledge base can define its own taxonomy; BUNDLED_CATEGORIES
  // below documents the canonical slugs shipped with this repo.
  category: z.string().min(1),
  relevanceForFinancialSector: z.enum(['critical', 'high', 'medium', 'low']),
  bindingLevel: z.enum(['mandatory', 'supervisory_expectation', 'best_practice']),
  enforcementConsequence: z.string(),
  financialSectorGuidance: z.string().optional(),
  controls: z.array(Control).default([]),
  // German translations (populated by scripts/translate-kb.ts)
  titleDe: z.string().optional(),
  summaryDe: z.string().optional(),
  bodyDe: z.string().optional(),
  enforcementConsequenceDe: z.string().optional(),
  financialSectorGuidanceDe: z.string().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const RegulationMeta = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  jurisdiction: z.enum(['EU', 'CH', 'DE', 'INTL']),
  effectiveDate: z.string().optional(),
  description: z.string(),
  bindingLevel: z.enum(['mandatory', 'supervisory_expectation', 'best_practice']),
  enforcementConsequence: z.string(),
  // German translations (populated by scripts/translate-kb.ts)
  nameDe: z.string().optional(),
  descriptionDe: z.string().optional(),
  enforcementConsequenceDe: z.string().optional(),
});
export type RegulationMeta = z.infer<typeof RegulationMeta>;

/** Audit snapshot generated by scripts/generate-kb-manifest.ts. */
export const KbManifest = z.object({
  kbVersion: z.string(),
  generatedAt: z.string(),
  totals: z.object({
    requirements: z.number(),
    controls: z.number(),
    regulations: z.number(),
    crosswalk: z.number(),
  }),
  verification: z.object({
    manuallyVerified: z.number(),
    coveragePct: z.number(),
    byMethod: z.record(z.string(), z.number()),
  }),
  sourceChecksums: z.object({
    manifest: z.string(),
    present: z.boolean(),
    sha256: z.string().nullable(),
  }),
});
export type KbManifest = z.infer<typeof KbManifest>;

export const CrosswalkEntry = z.object({
  id: z.string(),
  topic: z.string(),
  description: z.string(),
  requirements: z.array(z.string()),
  standards: z.array(z.string()),
  // German translations (populated by scripts/translate-kb.ts)
  topicDe: z.string().optional(),
  descriptionDe: z.string().optional(),
});
export type CrosswalkEntry = z.infer<typeof CrosswalkEntry>;
