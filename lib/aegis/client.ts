import type { ModelId } from './types';
import type { ClaudeUsage } from './context/cost';
import type {
  ProviderCallParams,
  ProviderMessage,
  ProviderMessageStream,
} from './providers/types';
import { getProvider } from './providers/registry';

/**
 * Model-layer facade.
 *
 * Every model call inside `lib/aegis/` goes through these functions, which
 * delegate to the registry-selected {@link ModelProvider} (the "brain"). The
 * concrete backend — dispatch, retry, prompt-cache, error taxonomy, message
 * translation — lives behind the provider interface (see `providers/`). Swapping
 * the brain is a registry concern; callers here are backend-agnostic.
 */

// Canonical dispatch params/return types, re-exported so callers depend on the
// provider layer rather than any vendor SDK.
export type ClaudeCallParams = ProviderCallParams;
export type ClaudeMessageStream = ProviderMessageStream;

// Retained helpers, re-exported from the reference backend so existing call
// sites and unit tests keep their import path.
export {
  reportModelDrift,
  getClient,
  withMessageCacheBreakpoint,
  shouldRetry,
  retryDelayMs,
  readRetryAfterSeconds,
  classifyUpstream,
} from './providers/anthropic';

/** Non-streaming message create (main loop + helpers route through here). */
export function callClaude(params: ClaudeCallParams): Promise<ProviderMessage> {
  return getProvider().createMessage(params);
}

/** Streaming message create (SSE path). */
export function streamClaude(params: ClaudeCallParams): Promise<ClaudeMessageStream> {
  return getProvider().streamMessage(params);
}

/** Single-shot text helper (intent classification, compaction). */
export function callHaiku(params: {
  model: ModelId;
  prompt: string;
  maxTokens: number;
}): Promise<{ text: string; usage: ClaudeUsage }> {
  return getProvider().completeText(params);
}

/** Single-shot schema-constrained structured output (compaction digest). */
export function callStructured<T>(params: {
  model: ModelId;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<{ value: T; usage: ClaudeUsage }> {
  return getProvider().structured<T>(params);
}
