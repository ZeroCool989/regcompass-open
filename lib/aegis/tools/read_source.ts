import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { rankPassages } from './_passages';

/**
 * read_source — fallback tool that searches the raw legislation text in
 * `docs/source/*.txt` when `search_kb` returns too few hits. Returns up to
 * `maxPassages` matching passages with metadata flagged `verified: false`.
 *
 * Path safety: this file is the documented exception to the "no fs in
 * lib/aegis/tools" boundary (see __tests__/boundary.test.ts). The exception
 * is contained: every read is path-resolved against ALLOWED_DIR and rejected
 * if it would escape that directory. The agent picks a regulation from a
 * fixed enum — there is no raw filename input surface.
 *
 * Output discipline: every passage carries `source: "raw_legislation"` and
 * `verified: false`. The system prompt instructs the agent to mark any
 * statement derived from a read_source passage with the visible warning
 * "⚠️ Quelle: Gesetzestext (nicht in KB verifiziert)".
 */

// Set of regulation IDs that have a corresponding source file in docs/source/.
// ISO_23894 is intentionally excluded — no source file present.
export type ReadSourceRegulation =
  | 'EU_AI_ACT'
  | 'DORA'
  | 'GDPR'
  | 'NIS2'
  | 'DSA'
  | 'DATA_ACT'
  | 'PRODUCT_LIABILITY'
  | 'FINMA_08_2024'
  | 'FINMA_RS_2023_1'
  | 'FINMA_RS_2018_3'
  | 'REVDSG'
  | 'BDSG'
  | 'BSIG'
  | 'MARISK'
  | 'BAIT'
  | 'ISO_42001'
  | 'ISO_42005'
  | 'NIST_AI_RMF';

const REGULATION_TO_FILE: Record<ReadSourceRegulation, string> = {
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
};

// ───────────────────────── Schema ─────────────────────────

export const READ_SOURCE_SCHEMA: Anthropic.Tool = {
  name: 'read_source',
  description:
    'Fallback tool: searches the raw legislation texts in docs/source/ when search_kb returns too few hits (< 3) or misses an article that turns out to be relevant. ' +
    'Returns up to `maxPassages` ranked passages from the requested regulation\'s source file, each marked `verified: false` because the passages have not been curated into the KB. ' +
    'Use this only AFTER search_kb has been tried and proved insufficient. The agent MUST mark any answer derived from a read_source passage with "⚠️ Quelle: Gesetzestext (nicht in KB verifiziert)" so the user can see it has not been curated. Recommend that the user request the RegCompass team to add the missing entries to the KB.',
  input_schema: {
    type: 'object',
    properties: {
      regulation: {
        type: 'string',
        enum: [
          'EU_AI_ACT',
          'DORA',
          'GDPR',
          'NIS2',
          'DSA',
          'DATA_ACT',
          'PRODUCT_LIABILITY',
          'FINMA_08_2024',
          'FINMA_RS_2023_1',
          'FINMA_RS_2018_3',
          'REVDSG',
          'BDSG',
          'BSIG',
          'MARISK',
          'BAIT',
          'ISO_42001',
          'ISO_42005',
          'NIST_AI_RMF',
        ],
        description:
          'Regulation whose source file should be searched. ISO_23894 is not available — no source text in the repository.',
      },
      query: {
        type: 'string',
        description: 'Free-text query in DE or EN. Tokenised; passages with the most token hits rank first.',
      },
      maxPassages: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        default: 3,
        description: 'Maximum number of passages to return. Capped at 5.',
      },
    },
    required: ['regulation', 'query'],
  },
};

// ───────────────────────── Path safety ─────────────────────────

const ALLOWED_DIR = path.resolve(process.cwd(), 'docs', 'source');

function resolveSourcePath(filename: string): string {
  const fullPath = path.resolve(ALLOWED_DIR, filename);
  // Strict containment check: the resolved path must be inside ALLOWED_DIR.
  // Using `+ path.sep` prevents prefix-confusion attacks where another
  // directory happens to share the ALLOWED_DIR prefix.
  if (
    fullPath !== ALLOWED_DIR &&
    !fullPath.startsWith(ALLOWED_DIR + path.sep)
  ) {
    throw new Error(
      `source_access_denied: path traversal blocked for "${filename}"`,
    );
  }
  return fullPath;
}

// Hard cap to keep tool results bounded (passage split/score lives in _passages).
const ABSOLUTE_MAX_PASSAGES = 5;

// ───────────────────────── Executor ─────────────────────────

type ReadSourceInput = {
  regulation: ReadSourceRegulation;
  query: string;
  maxPassages?: number;
};

export type ReadSourcePassage = {
  source: 'raw_legislation';
  verified: false;
  file: string;
  regulation: ReadSourceRegulation;
  passage: string;
  score: number;
};

export function executeReadSource(input: ReadSourceInput): ReadSourcePassage[] {
  // Validate regulation against the closed mapping. The agent is bound to the
  // enum at the Anthropic API level; this check is defence-in-depth for direct
  // executor calls (tests, internal callers).
  const filename = REGULATION_TO_FILE[input.regulation];
  if (!filename) {
    throw new Error(
      `source_access_denied: no source file available for regulation "${input.regulation}"`,
    );
  }

  const fullPath = resolveSourcePath(filename);

  if (!existsSync(fullPath)) {
    throw new Error(
      `source_access_denied: source file missing on disk: "${filename}"`,
    );
  }

  const text = readFileSync(fullPath, 'utf8');

  const cap = Math.min(Math.max(input.maxPassages ?? 3, 1), ABSOLUTE_MAX_PASSAGES);
  return rankPassages(text, input.query, cap).map(({ passage, score }) => ({
    source: 'raw_legislation',
    verified: false,
    file: filename,
    regulation: input.regulation,
    passage,
    score,
  }));
}
