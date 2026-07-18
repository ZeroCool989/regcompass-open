/**
 * One-shot, idempotent governance migration for lib/kb/requirements.json.
 * Run: npx tsx scripts/kb-migrate-governance.ts
 *
 * Applies three data migrations (see docs/governance/MIGRATION_NOTES.md):
 *  1. Verification-metadata backfill from docs/VERIFICATION_REPORT.md
 *     (per-regulation verifier + date). Existing verification metadata is
 *     never overwritten.
 *  2. sourcePdf → sourceFile: every entry gets a sourceFile that resolves to
 *     a real file in docs/source/, derived from its regulation. The legacy
 *     sourcePdf field is removed (its values did not resolve on disk).
 *  3. riskTier canonicalization: synonym values are mapped onto the
 *     canonical EU-AI-Act-tier enum (ADR-001).
 *  4. Control-ID collision repair: control IDs that were reused across
 *     entries with DIVERGENT content are renamed to requirement-derived IDs
 *     (C-<requirement-suffix>-NN) so every control ID resolves to exactly
 *     one control. Identical-content reuse (shared controls) is left as-is.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KB_PATH = join(root, 'lib/kb/requirements.json');
const SOURCE_DIR = join(root, 'docs/source');

// docs/VERIFICATION_REPORT.md, table "Per-Regulation Verification Status".
// EU_AI_ACT / DORA / NIS2 were bulk-extracted (2026-05-19) and are NOT
// manually verified; ISO_23894 is on automated-crosscheck-v1, pending QC.
const MANUAL_VERIFIED_2026_05_25 = new Set([
  'GDPR', 'REVDSG', 'FINMA_08_2024', 'FINMA_RS_2023_1', 'FINMA_RS_2018_3',
  'DSA', 'MARISK', 'BAIT', 'DATA_ACT', 'BDSG', 'BSIG', 'PRODUCT_LIABILITY',
  'NIST_AI_RMF', 'ISO_42001', 'ISO_42005',
]);
const BULK_EXTRACTED_2026_05_19 = new Set(['EU_AI_ACT', 'DORA', 'NIS2']);

export const SOURCE_FILE_BY_REGULATION: Record<string, string | null> = {
  EU_AI_ACT: 'eu_ai_act_DE.txt',
  DORA: 'eu_dora_act_DE.txt',
  GDPR: 'eu_GDPR_act_DE.txt',
  NIS2: 'eu_nis2_act_DE.txt',
  DSA: 'eu_dsa_act_DE.txt',
  DATA_ACT: 'eu_data_act_DE.txt',
  PRODUCT_LIABILITY: 'eu_product_liability_directive_DE.txt',
  FINMA_08_2024: 'FINMA 082024_DE.txt',
  FINMA_RS_2023_1: 'FINMA RS 2023_1_DE.txt',
  FINMA_RS_2018_3: 'FINMA RS 2018_3_DE.txt',
  REVDSG: 'revDSG_DE.txt',
  BDSG: 'Bundesdatenschutzgesetz (BDSG)_DE.txt',
  BSIG: 'BSI-Gesetz - BSIG_DE.txt',
  MARISK: 'MaRisk_DE.txt',
  BAIT: 'BAIT_DE.txt',
  ISO_42001: 'ISO-42001_DE.txt',
  ISO_42005: 'Iso-42005-2024-Dis-Standard_DRAFT_DE.txt',
  NIST_AI_RMF: 'nist.ai.100-1_DE.txt',
  // No primary source text available — provenance waiver, see
  // docs/governance/MIGRATION_NOTES.md and validate-kb PROVENANCE_WAIVERS.
  ISO_23894: null,
};

const RISK_TIER_CANONICAL: Record<string, string> = {
  unacceptable: 'prohibited',
  high: 'high-risk',
  limited: 'limited-risk',
  minimal: 'minimal-risk',
};

type ControlJson = Record<string, unknown> & { id: string };

function controlFingerprint(c: ControlJson): string {
  const keys = ['action', 'description', 'priority', 'complexity', 'standard', 'standardClause'];
  return JSON.stringify(keys.map(k => c[k] ?? null));
}

/** Control IDs used by >1 entry with divergent content — every occurrence
 *  gets a requirement-derived ID so the ID uniquely identifies one control. */
function divergentControlIds(reqs: Record<string, unknown>[]): Set<string> {
  const variants = new Map<string, Set<string>>();
  for (const r of reqs) {
    for (const c of (r.controls as ControlJson[] | undefined) ?? []) {
      if (!variants.has(c.id)) variants.set(c.id, new Set());
      variants.get(c.id)!.add(controlFingerprint(c));
    }
  }
  return new Set([...variants.entries()].filter(([, v]) => v.size > 1).map(([id]) => id));
}

function main() {
  const reqs: Record<string, unknown>[] = JSON.parse(readFileSync(KB_PATH, 'utf8'));
  let verifiedSet = 0, methodSet = 0, sourceSet = 0, tierFixed = 0, controlsRenamed = 0;
  const divergent = divergentControlIds(reqs);

  for (const r of reqs) {
    const reg = r.regulation as string;

    // 1. Verification backfill — never overwrite existing metadata.
    if (MANUAL_VERIFIED_2026_05_25.has(reg)) {
      if (r.verified !== true) { r.verified = true; verifiedSet++; }
      if (!r.verifiedBy) r.verifiedBy = 'manual-source-verification-2026-05-25';
      if (!r.verifiedAt) r.verifiedAt = '2026-05-25';
      if (!r.verificationMethod) { r.verificationMethod = 'manual-source-verification'; methodSet++; }
    } else if (BULK_EXTRACTED_2026_05_19.has(reg)) {
      if (!r.verificationMethod) { r.verificationMethod = 'primary-source-extraction'; methodSet++; }
    } else if (reg === 'ISO_23894') {
      if (!r.verificationMethod) { r.verificationMethod = 'automated-crosscheck-v1'; methodSet++; }
    }

    // 2. sourceFile normalization.
    const file = SOURCE_FILE_BY_REGULATION[reg];
    if (file !== undefined) {
      if (file !== null && r.sourceFile !== file) {
        if (!existsSync(join(SOURCE_DIR, file))) {
          throw new Error(`source file missing on disk: ${file} (regulation ${reg})`);
        }
        r.sourceFile = file;
        sourceSet++;
      }
    } else {
      throw new Error(`no sourceFile mapping for regulation ${reg}`);
    }
    delete r.sourcePdf;

    // 3. riskTier canonicalization.
    const tier = r.riskTier as string | undefined;
    if (tier && RISK_TIER_CANONICAL[tier]) {
      r.riskTier = RISK_TIER_CANONICAL[tier];
      tierFixed++;
    }

    // 4. Control-ID collision repair (divergent cross-entry reuse only).
    const controls = (r.controls as ControlJson[] | undefined) ?? [];
    controls.forEach((c, i) => {
      if (divergent.has(c.id)) {
        c.id = `C-${(r.id as string).replace(/^R-/, '')}-${String(i + 1).padStart(2, '0')}`;
        controlsRenamed++;
      }
    });
  }

  writeFileSync(KB_PATH, JSON.stringify(reqs, null, 2) + '\n');
  const verifiedTotal = reqs.filter(r => r.verified === true).length;
  console.log(`entries: ${reqs.length}`);
  console.log(`verified flags newly set: ${verifiedSet} (total verified now: ${verifiedTotal})`);
  console.log(`verificationMethod set: ${methodSet}`);
  console.log(`sourceFile set: ${sourceSet}`);
  console.log(`riskTier canonicalized: ${tierFixed}`);
  console.log(`control IDs renamed (divergent collisions): ${controlsRenamed}`);
  const remaining = divergentControlIds(reqs);
  if (remaining.size > 0) {
    throw new Error(`divergent control IDs remain after migration: ${[...remaining].join(', ')}`);
  }
}

main();
