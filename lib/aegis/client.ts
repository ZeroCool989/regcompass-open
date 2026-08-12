import type { ModelId } from './types';
import type { ClaudeUsage } from './context/cost';
import type {
  ProviderCallParams,
  ProviderMessage,
  ProviderMessageStream,
} from './providers/types';
import { getProvider, getProviderFor } from './providers/registry';
import { activeOAuthProviderId } from './providers/catalog';
import { getAccessToken } from './oauth';

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

/**
 * Attach a connected subscription's OAuth token to the call when appropriate.
 *
 * Credential precedence: an explicit key/token on the call wins; otherwise, if
 * a subscription is connected for the active brain's family, its access token
 * (auto-refreshed) is used; otherwise the provider falls back to its env key.
 * A local-only concern — with no connections configured this is a cheap no-op.
 */
async function withSubscription<T extends { model: ModelId; apiKey?: string | null; authToken?: string | null }>(
  params: T,
): Promise<T> {
  if (params.apiKey || params.authToken) return params;
  const id = activeOAuthProviderId(params.model);
  if (!id) return params;
  const token = await getAccessToken(id);
  return token ? { ...params, authToken: token } : params;
}

/** Non-streaming message create (main loop + helpers route through here). */
export async function callClaude(params: ClaudeCallParams): Promise<ProviderMessage> {
  const p = await withSubscription(params);
  return getProviderFor(p.provider, p.model).createMessage(p);
}

/** Streaming message create (SSE path). */
export async function streamClaude(params: ClaudeCallParams): Promise<ClaudeMessageStream> {
  const p = await withSubscription(params);
  return getProviderFor(p.provider, p.model).streamMessage(p);
}

/** Single-shot text helper (intent classification, compaction). */
export async function callHaiku(params: {
  model: ModelId;
  prompt: string;
  maxTokens: number;
  apiKey?: string | null;
  authToken?: string | null;
  /** Explicit request-scoped provider — honours the selection over AEGIS_BRAIN. */
  provider?: 'anthropic' | 'gemini';
}): Promise<{ text: string; usage: ClaudeUsage }> {
  const p = await withSubscription(params);
  return getProviderFor(p.provider, p.model).completeText(p);
}

/** Single-shot schema-constrained structured output (compaction digest). */
export async function callStructured<T>(params: {
  model: ModelId;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  apiKey?: string | null;
  authToken?: string | null;
  /** Explicit request-scoped provider — honours the selection over AEGIS_BRAIN. */
  provider?: 'anthropic' | 'gemini';
}): Promise<{ value: T; usage: ClaudeUsage }> {
  const p = await withSubscription(params);
  return getProviderFor(p.provider, p.model).structured<T>(p);
}
