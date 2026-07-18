import type { ModelProvider } from './types';
import { AnthropicProvider } from './anthropic';

/**
 * Provider registry — selects the brain for a run.
 *
 * Today there is one backend (Anthropic). Additional backends
 * (OpenAI-compatible, subscription-OAuth, local, CLI bridge) register here and
 * are chosen by the resolved credential/model. The rest of AEGIS depends only
 * on {@link ModelProvider}, never on a concrete backend.
 */

const _anthropic = new AnthropicProvider();

export function getProvider(): ModelProvider {
  return _anthropic;
}
