import type { ModelProvider } from './types';
import { resolveProvider } from './catalog';

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
