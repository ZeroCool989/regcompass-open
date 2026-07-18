import type Anthropic from '@anthropic-ai/sdk';
import type { ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';
import type { SystemBlock } from '../modes';

/**
 * Provider-neutral model layer.
 *
 * AEGIS speaks to exactly one backend at a time — the *brain* — selected at
 * runtime by the registry. Every backend implements {@link ModelProvider}.
 *
 * The canonical in-process message format is the structural shape used by the
 * reference backend (message / content-block / tool_use / tool_result / stream
 * events). It is defined here under provider-neutral names so the rest of the
 * codebase depends on THIS module, not on any vendor SDK. A non-reference
 * backend implements the interface by translating its own wire format to and
 * from these shapes — the standard "canonical internal format" adapter pattern.
 * Only the reference adapter imports the vendor SDK directly.
 */

// Canonical message shapes (structural — any backend maps its wire format onto these).
export type ProviderMessage = Anthropic.Message;
export type ProviderMessageParam = Anthropic.MessageParam;
export type ProviderContentBlock = Anthropic.ContentBlock;
export type ProviderContentBlockParam = Anthropic.ContentBlockParam;
export type ProviderTextBlock = Anthropic.TextBlock;
export type ProviderTool = Anthropic.Tool;
export type ProviderToolChoice = Anthropic.MessageCreateParams['tool_choice'];
export type ProviderStopReason = Anthropic.Message['stop_reason'];

/**
 * Canonical streaming event. The agent loop reads only `content_block_start`
 * (for tool_use) and `content_block_delta` (text_delta); every backend emits
 * events of this shape so the loop stays backend-agnostic.
 */
export type ProviderStreamEvent = Anthropic.MessageStreamEvent;

/**
 * Minimal streaming container the loop consumes: async-iterable over canonical
 * events, plus a `finalMessage()` resolving the assembled message. The reference
 * backend's SDK stream satisfies this structurally; other backends build a small
 * object that does the same.
 */
export interface ProviderMessageStream extends AsyncIterable<ProviderStreamEvent> {
  finalMessage(): Promise<ProviderMessage>;
}

/** What a backend can and cannot do. Missing capabilities degrade to no-ops, never errors. */
export type ProviderCapabilities = {
  /** Honors ephemeral prompt-cache breakpoints. When false, cache hints are dropped, not rejected. */
  promptCache: boolean;
  /** Accepts a tool_choice override (e.g. forcing a tool-free final answer). */
  toolChoice: boolean;
  /** Supports schema-constrained structured output in a single shot. */
  structuredOutput: boolean;
};

/** A model dispatch request, expressed in canonical terms. */
export type ProviderCallParams = {
  model: ModelId;
  systemBlocks: SystemBlock[];
  tools: ProviderTool[];
  messages: ProviderMessageParam[];
  maxTokens: number;
  /** Optional per-user API key (BYOK). Never logged or returned. */
  apiKey?: string | null;
  /** Optional tool-choice override; kept out of the cached prefix. */
  toolChoice?: ProviderToolChoice;
};

/**
 * The brain. One implementation per backend (reference vendor, OpenAI-compatible,
 * subscription-OAuth, local, CLI bridge …). Selected by the registry.
 */
export interface ModelProvider {
  /** Stable id, e.g. "anthropic". */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  /** Non-streaming message create, with retry + error normalization. */
  createMessage(params: ProviderCallParams): Promise<ProviderMessage>;

  /** Streaming message create; caller iterates events and may await the final message. */
  streamMessage(params: ProviderCallParams): Promise<ProviderMessageStream>;

  /** Single-shot text-in/text-out helper (intent classification, compaction). */
  completeText(params: {
    model: ModelId;
    prompt: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: ClaudeUsage }>;

  /** Single-shot schema-constrained structured output. */
  structured<T>(params: {
    model: ModelId;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens: number;
  }): Promise<{ value: T; usage: ClaudeUsage }>;
}
