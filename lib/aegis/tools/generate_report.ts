import type Anthropic from '@anthropic-ai/sdk';

/**
 * Phase-4 placeholder. The schema is registered so the model knows the tool
 * *exists* but the executor returns an error block so the model summarises
 * in-line instead.
 *
 * When Phase 4 lands, this file gets a real schema and executor.
 */
export const GENERATE_REPORT_SCHEMA: Anthropic.Tool = {
  name: 'generate_report',
  description:
    'PLACEHOLDER — not yet implemented in Phase 1. ' +
    'Calling this tool returns an error directing you to summarise findings in your text response instead.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: true,
  },
};

export type GenerateReportStub = {
  status: 'not_implemented';
  phase: 4;
  message: string;
};

export function executeGenerateReport(_input: unknown): GenerateReportStub {
  return {
    status: 'not_implemented',
    phase: 4,
    message:
      'generate_report is a Phase-4 capability. Summarise findings in your text response instead.',
  };
}
