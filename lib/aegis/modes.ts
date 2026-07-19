import { AEGIS_SYSTEM_PROMPT } from './prompts/identity';
import { buildPrompt as buildAssessPrompt } from './prompts/mode_assess';
import { buildPrompt as buildGapPrompt } from './prompts/mode_gap';
import { buildPrompt as buildConversationalPrompt } from './prompts/mode_conversational';
import { intEnv } from './env';
import type { AegisMode, ToolName } from './types';

export type SystemBlock = {
  text: string;
  /**
   * If `true`, this block is part of the cacheable prefix.
   * `client.ts` places the cache breakpoint on the **last** block whose
   * `cached` flag is true; everything up to and including that block is
   * served from the Anthropic prompt cache when the prefix matches.
   */
  cached: boolean;
};

export type ModeSpec = {
  systemBlocks: SystemBlock[];
  defaultTools: ToolName[];
  maxTokens: number;
  maxIterations: number;
};

const MODE_TOOLS: Record<AegisMode, ToolName[]> = {
  ASSESS: ['search_kb', 'get_requirements', 'get_crosswalk', 'read_source', 'search_ingested_documents', 'generate_assessment_deck', 'export_assessment'],
  GAP_ANALYZE: ['search_kb', 'get_requirements', 'get_crosswalk', 'analyze_document', 'fill_template', 'read_source', 'search_ingested_documents', 'generate_assessment_deck', 'export_assessment', 'improve_uploaded_deck', 'improve_document'],
  CONVERSATIONAL: ['search_kb', 'get_requirements', 'get_crosswalk', 'read_source', 'search_ingested_documents', 'export_assessment'],
};

// Per-mode output ceiling — the SINGLE source of truth for max output tokens.
// Sized for complete professional deliverables (catalogues, frameworks,
// management summaries). Continuation (loop.ts) scales beyond a single call when
// the model genuinely hits the window; all configured Claude 4.x models accept
// these comfortably (Haiku hard cap 64000, Sonnet/Opus higher). Env-overridable.
const MODE_MAX_TOKENS: Record<AegisMode, number> = {
  ASSESS: intEnv('AEGIS_MAX_TOKENS_ASSESS', 16384),
  GAP_ANALYZE: intEnv('AEGIS_MAX_TOKENS_GAP_ANALYZE', 16384),
  CONVERSATIONAL: intEnv('AEGIS_MAX_TOKENS_CONVERSATIONAL', 8192),
};

// Per-mode tool-loop iteration ceiling — also the single source of truth
// (routeToModel no longer carries this). Env-overridable.
const MODE_MAX_ITERATIONS: Record<AegisMode, number> = {
  CONVERSATIONAL: intEnv('AEGIS_MAX_ITERATIONS_CONVERSATIONAL', 10),
  ASSESS: intEnv('AEGIS_MAX_ITERATIONS_ASSESS', 15),
  GAP_ANALYZE: intEnv('AEGIS_MAX_ITERATIONS_GAP_ANALYZE', 25),
};

/**
 * Builds the system block list + tool subset for a given (mode, language) tuple.
 *
 * Block layout (Spec §4.3):
 *   [0] identity      — always identical, fully cached.
 *   [1] mode + language directive — cached per (mode, language) tuple; cache hit
 *       requires the user to stay on the same language within a conversation.
 *
 * The language directive is fused into block [1] (not a separate block) because
 * Anthropic's prompt cache fragments on exact prefix match — and we want hits
 * within a language session rather than only on the identity prefix.
 */
export function getModeSpec(mode: AegisMode, language: 'de' | 'en'): ModeSpec {
  const modePrompt = buildModePrompt(mode, language);
  return {
    systemBlocks: [
      { text: AEGIS_SYSTEM_PROMPT, cached: true },
      { text: modePrompt, cached: true },
    ],
    defaultTools: MODE_TOOLS[mode],
    maxTokens: MODE_MAX_TOKENS[mode],
    maxIterations: MODE_MAX_ITERATIONS[mode],
  };
}

function buildModePrompt(mode: AegisMode, language: 'de' | 'en'): string {
  switch (mode) {
    case 'ASSESS':
      return buildAssessPrompt({ language });
    case 'GAP_ANALYZE':
      return buildGapPrompt({ language });
    case 'CONVERSATIONAL':
      return buildConversationalPrompt({ language });
  }
}
