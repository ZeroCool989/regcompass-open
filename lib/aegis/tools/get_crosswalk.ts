import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import type { CrosswalkEntry } from '@/lib/kb/types';

export const GET_CROSSWALK_SCHEMA: Anthropic.Tool = {
  name: 'get_crosswalk',
  description:
    'Returns cross-regulation mapping entries that show overlapping obligations across multiple regulations. ' +
    'Filter by `topic` (substring, case-insensitive) and/or by a specific `requirementId` (returns only entries that include that requirement). ' +
    'Returns all entries when both filters are empty.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description:
          'Case-insensitive substring match against the entry topic. Examples: "risk management", "data governance", "human oversight".',
      },
      requirementId: {
        type: 'string',
        pattern: '^R-[A-Z0-9]+-[A-Z0-9-]+$',
        description: 'Optional KB requirement ID (e.g. "R-AIACT-009").',
      },
    },
  },
};

type GetCrosswalkInput = {
  topic?: string;
  requirementId?: string;
};

export function executeGetCrosswalk(
  input: GetCrosswalkInput,
): CrosswalkEntry[] {
  const topic = input.topic?.toLowerCase().trim();
  const reqId = input.requirementId?.trim();

  return KB.crosswalk.filter((entry) => {
    if (topic && !entry.topic.toLowerCase().includes(topic)) return false;
    if (reqId && !entry.requirements.includes(reqId)) return false;
    return true;
  });
}
