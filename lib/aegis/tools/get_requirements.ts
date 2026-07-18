import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import type { Requirement } from '@/lib/kb/types';

/**
 * Batch fetch of FULL requirement records by ID (3.5). `search_kb` strips the
 * verbose `body` to save tokens; this tool returns the bodies for a set of IDs
 * in ONE call, so a deep-dive over N hits costs one round trip instead of N
 * single-ID re-queries.
 */
export const GET_REQUIREMENTS_SCHEMA: Anthropic.Tool = {
  name: 'get_requirements',
  description:
    'Fetch the FULL records (including the `body` legislation text) for specific ' +
    'requirement IDs in a single call. Use this AFTER search_kb to pull the bodies ' +
    'of the most relevant hits at once, instead of calling search_kb again once per ID. ' +
    'IDs look like "R-DORA-001". Returns the resolved records plus any IDs that did not match.',
  input_schema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 20,
        description:
          'Requirement IDs to fetch, e.g. ["R-DORA-001", "R-GDPR-022"]. Up to 20 per call.',
      },
    },
    required: ['ids'],
  },
};

// Defense-in-depth cap mirroring the schema `maxItems` — the schema is advisory
// to the model; the executor enforces the ceiling regardless of what arrives.
const MAX_IDS = 20;

type GetRequirementsInput = { ids?: unknown };

export type GetRequirementsResult = {
  requirements: Requirement[];
  notFound: string[];
};

export function executeGetRequirements(input: GetRequirementsInput): GetRequirementsResult {
  const raw = Array.isArray(input?.ids) ? input.ids : [];
  // Normalise to strings, drop blanks, dedupe (preserving order), then cap.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_IDS) break;
  }

  const requirements: Requirement[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const r = KB.byId(id);
    if (r) requirements.push(r);
    else notFound.push(id);
  }
  return { requirements, notFound };
}
