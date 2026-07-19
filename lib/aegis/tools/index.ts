import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCall, ToolContext, ToolName, ToolResult } from '../types';
import {
  SEARCH_KB_SCHEMA,
  executeSearchKb,
} from './search_kb';
import {
  GET_REQUIREMENTS_SCHEMA,
  executeGetRequirements,
} from './get_requirements';
import {
  GET_CROSSWALK_SCHEMA,
  executeGetCrosswalk,
} from './get_crosswalk';
import {
  GENERATE_REPORT_SCHEMA,
  executeGenerateReport,
} from './generate_report';
import {
  ANALYZE_DOCUMENT_SCHEMA,
  executeAnalyzeDocument,
} from './analyze_document';
import {
  FILL_TEMPLATE_SCHEMA,
  executeFillTemplate,
} from './fill_template';
import {
  READ_SOURCE_SCHEMA,
  executeReadSource,
} from './read_source';
import {
  SEARCH_INGESTED_DOCUMENTS_SCHEMA,
  executeSearchIngestedDocuments,
} from './search_ingested_documents';
import {
  GENERATE_ASSESSMENT_DECK_SCHEMA,
  executeGenerateAssessmentDeck,
} from './generate_assessment_deck';
import {
  EXPORT_ASSESSMENT_SCHEMA,
  executeExportAssessment,
} from './export_assessment';
import {
  IMPROVE_UPLOADED_DECK_SCHEMA,
  executeImproveUploadedDeck,
} from './improve_uploaded_deck';
import {
  IMPROVE_DOCUMENT_SCHEMA,
  executeImproveDocument,
} from './improve_document';

/**
 * Tool registry returned by `createToolRegistry()`.
 *
 * `schemas` is the Anthropic-formatted Tool[] passed into `messages.create`.
 * `execute` dispatches a `ToolCall` from a `tool_use` block to the matching
 * executor, returns a `ToolResult` ready to append as a `tool_result` block.
 *
 * Phase-1 placeholder (`generate_report`) returns `is_error: true` so the
 * model knows to summarise in-line / ask the user.
 */
export type ToolRegistry = {
  readonly schemas: Anthropic.Tool[];
  execute: (call: ToolCall) => Promise<ToolResult>;
};

const SCHEMA_BY_NAME: Record<ToolName, Anthropic.Tool> = {
  search_kb: SEARCH_KB_SCHEMA,
  get_requirements: GET_REQUIREMENTS_SCHEMA,
  get_crosswalk: GET_CROSSWALK_SCHEMA,
  generate_report: GENERATE_REPORT_SCHEMA,
  analyze_document: ANALYZE_DOCUMENT_SCHEMA,
  fill_template: FILL_TEMPLATE_SCHEMA,
  read_source: READ_SOURCE_SCHEMA,
  search_ingested_documents: SEARCH_INGESTED_DOCUMENTS_SCHEMA,
  generate_assessment_deck: GENERATE_ASSESSMENT_DECK_SCHEMA,
  export_assessment: EXPORT_ASSESSMENT_SCHEMA,
  improve_uploaded_deck: IMPROVE_UPLOADED_DECK_SCHEMA,
  improve_document: IMPROVE_DOCUMENT_SCHEMA,
};

const ALL_TOOL_NAMES: ToolName[] = [
  'search_kb',
  'get_requirements',
  'get_crosswalk',
  'generate_report',
  'analyze_document',
  'fill_template',
  'read_source',
  'search_ingested_documents',
  'generate_assessment_deck',
  'export_assessment',
  'improve_uploaded_deck',
  'improve_document',
];

async function dispatch(
  name: ToolName,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: unknown; isError: boolean }> {
  switch (name) {
    case 'search_kb':
      return { content: executeSearchKb(input as Parameters<typeof executeSearchKb>[0]), isError: false };
    case 'get_requirements':
      return { content: executeGetRequirements(input as Parameters<typeof executeGetRequirements>[0]), isError: false };
    case 'get_crosswalk':
      return { content: executeGetCrosswalk(input as Parameters<typeof executeGetCrosswalk>[0]), isError: false };
    case 'generate_report':
      return { content: executeGenerateReport(input), isError: true };
    case 'analyze_document':
      return { content: await executeAnalyzeDocument(input, ctx), isError: false };
    case 'fill_template':
      return { content: await executeFillTemplate(input, ctx), isError: false };
    case 'read_source':
      return { content: executeReadSource(input as Parameters<typeof executeReadSource>[0]), isError: false };
    case 'search_ingested_documents':
      return { content: await executeSearchIngestedDocuments(input as Parameters<typeof executeSearchIngestedDocuments>[0]), isError: false };
    case 'generate_assessment_deck':
      return { content: await executeGenerateAssessmentDeck(input, ctx), isError: false };
    case 'export_assessment':
      return { content: await executeExportAssessment(input, ctx), isError: false };
    case 'improve_uploaded_deck':
      return { content: await executeImproveUploadedDeck(input, ctx), isError: false };
    case 'improve_document':
      return { content: await executeImproveDocument(input, ctx), isError: false };
  }
}

/**
 * Build a fresh registry. Call once per request — the schemas are immutable,
 * but isolating the closure keeps testing simple (each test gets its own).
 *
 * `subset` lets callers expose only the tools relevant to the current mode
 * (e.g. CONVERSATIONAL doesn't need `analyze_document`).
 */
export function createToolRegistry(
  subset?: ToolName[],
  ctx: ToolContext = { sessionId: null },
): ToolRegistry {
  const names = subset ?? ALL_TOOL_NAMES;
  const schemas = names.map((n) => SCHEMA_BY_NAME[n]);

  return {
    schemas,
    async execute(call: ToolCall): Promise<ToolResult> {
      // Telemetry: one chokepoint times every tool call (search_kb, get_crosswalk,
      // analyze_document, fill_template, …) so slow tools are visible in the logs.
      const startedAt = Date.now();
      try {
        const { content, isError } = await dispatch(call.name, call.input, ctx);
        const serialized = JSON.stringify(content);
        console.info(
          JSON.stringify({
            event: 'tool_call',
            tool: call.name,
            durationMs: Date.now() - startedAt,
            resultBytes: serialized.length,
            isError,
          }),
        );
        return {
          tool_use_id: call.id,
          content: serialized,
          is_error: isError,
        };
      } catch (err) {
        console.info(
          JSON.stringify({
            event: 'tool_call',
            tool: call.name,
            durationMs: Date.now() - startedAt,
            isError: true,
            threw: err instanceof Error ? err.name : 'Error',
          }),
        );
        return {
          tool_use_id: call.id,
          content: JSON.stringify({
            status: 'error',
            tool: call.name,
            message: err instanceof Error ? err.message : 'Unknown tool error',
          }),
          is_error: true,
        };
      }
    },
  };
}

// Re-exports for tests + verify (which needs to enumerate ALL_TOOL_NAMES).
export {
  SEARCH_KB_SCHEMA,
  GET_REQUIREMENTS_SCHEMA,
  GET_CROSSWALK_SCHEMA,
  GENERATE_REPORT_SCHEMA,
  ANALYZE_DOCUMENT_SCHEMA,
  FILL_TEMPLATE_SCHEMA,
  READ_SOURCE_SCHEMA,
  SEARCH_INGESTED_DOCUMENTS_SCHEMA,
  GENERATE_ASSESSMENT_DECK_SCHEMA,
  EXPORT_ASSESSMENT_SCHEMA,
  ALL_TOOL_NAMES,
};
