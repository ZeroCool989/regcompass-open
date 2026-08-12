import type { ModelProvider } from './types';
import { providerForSelection, resolveProvider } from './catalog';

/**
 * Provider registry — selects the brain for a run.
 *
 * Backends (Anthropic, OpenAI-compatible incl. local/self-hosted, Gemini) are
 * chosen by {@link resolveProvider}: a global `AEGIS_BRAIN` override, else the
 * routed model id's family. The rest of AEGIS depends only on
 * {@link ModelProvider}, never on a concrete backend. Default is Anthropic, so
 * behavior is unchanged unless another brain is configured.
 */
export function getProvider(model?: string): ModelProvider {
  return resolveProvider(model);
}

/**
 * Select the brain honouring an EXPLICIT request-scoped provider when present:
 * the user's selection wins over `AEGIS_BRAIN`/model-family. Falls back to
 * {@link resolveProvider} (the env/family escape hatch) only when no provider is
 * threaded on the call. This is how a user's chosen provider cannot be silently
 * replaced by an environment override.
 */
export function getProviderFor(
  provider: 'anthropic' | 'gemini' | undefined,
  model?: string,
): ModelProvider {
  return provider ? providerForSelection(provider) : resolveProvider(model);
}
