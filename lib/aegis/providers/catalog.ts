import { AegisError, type ModelProviderId } from '../types';
import type { ModelProvider } from './types';
import type { OAuthProviderId } from '../oauth/registry';
import { AnthropicProvider } from './anthropic';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { GeminiProvider } from './gemini';
import { CliBridgeProvider, cliBridgeConfigFromEnv } from './cli-bridge';

/**
 * Provider selection.
 *
 * Two mechanisms decide the brain:
 *  1. A global override via `AEGIS_BRAIN` (openai | ollama | custom | gemini) —
 *     points the whole app at one endpoint regardless of the routed model id.
 *     This is how a user runs AEGIS on a self-hosted or local model.
 *  2. Otherwise, selection by the routed model id's family (claude / gpt / gemini).
 *
 * Default is the reference Anthropic backend, so existing behavior is unchanged
 * unless the user opts into another brain.
 */

const anthropic = new AnthropicProvider();

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Build the global-override provider named by AEGIS_BRAIN, or null if none. */
function overrideProvider(): ModelProvider | null {
  const brain = env('AEGIS_BRAIN')?.toLowerCase();
  if (!brain || brain === 'anthropic') return null;

  if (brain === 'cli') {
    const cfg = cliBridgeConfigFromEnv();
    if (!cfg) {
      throw new AegisError(
        'invalid_input',
        'AEGIS_BRAIN=cli benötigt AEGIS_CLI_COMMAND=claude|codex|gemini.',
      );
    }
    return new CliBridgeProvider(cfg);
  }
  if (brain === 'gemini') {
    return new GeminiProvider({
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: env('GOOGLE_API_KEY') ?? env('GEMINI_API_KEY') ?? null,
    });
  }
  if (brain === 'ollama') {
    return new OpenAiCompatibleProvider({
      id: 'ollama',
      label: 'Ollama (local)',
      baseURL: env('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1',
      apiKey: env('OLLAMA_API_KEY') ?? 'ollama',
      modelOverride: env('OLLAMA_MODEL'),
      structuredOutput: false,
    });
  }
  if (brain === 'openai') {
    return new OpenAiCompatibleProvider({
      id: 'openai',
      label: 'OpenAI',
      baseURL: env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      apiKey: env('OPENAI_API_KEY') ?? null,
      modelOverride: env('OPENAI_MODEL'),
    });
  }
  // "custom" or any other value → a self-hosted OpenAI-compatible endpoint.
  return new OpenAiCompatibleProvider({
    id: 'custom',
    label: env('OPENAI_COMPAT_LABEL') ?? 'Self-hosted model',
    baseURL: env('OPENAI_COMPAT_BASE_URL') ?? 'http://localhost:8080/v1',
    apiKey: env('OPENAI_COMPAT_API_KEY') ?? null,
    modelOverride: env('OPENAI_COMPAT_MODEL'),
    structuredOutput: env('OPENAI_COMPAT_STRUCTURED') !== 'false',
  });
}

/** Select the provider for a routed model id (used when no global override is set). */
function providerForModel(model?: string): ModelProvider {
  if (!model || model.startsWith('claude')) return anthropic;
  if (model.startsWith('gemini')) {
    return new GeminiProvider({
      id: 'gemini',
      label: 'Google Gemini',
      apiKey: env('GOOGLE_API_KEY') ?? env('GEMINI_API_KEY') ?? null,
    });
  }
  // gpt-*, o1-*, o3-*, and any non-claude/non-gemini id → OpenAI proper.
  return new OpenAiCompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    baseURL: env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
    apiKey: env('OPENAI_API_KEY') ?? null,
  });
}

/** Resolve the brain for a run. */
export function resolveProvider(model?: string): ModelProvider {
  return overrideProvider() ?? providerForModel(model);
}

/**
 * The subscription provider whose OAuth token (if connected) should back the
 * active brain, or null when the active brain is a local/self-hosted endpoint
 * that has no subscription concept (Ollama, custom gateway). Mirrors the brain
 * selection in {@link resolveProvider}.
 */
export function activeOAuthProviderId(model?: string): OAuthProviderId | null {
  const brain = env('AEGIS_BRAIN')?.toLowerCase();
  if (brain && brain !== 'anthropic') {
    if (brain === 'gemini') return 'google';
    if (brain === 'openai') return 'openai';
    return null; // ollama / custom / self-hosted: no subscription
  }
  if (!model || model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'google';
  return 'openai';
}

/**
 * The cost-attribution provider for a routed model — the {@link ModelProviderId}
 * that owns this call for pricing and usage rows. Mirrors {@link resolveProvider}'s
 * brain selection (global `AEGIS_BRAIN` override first, else the routed model's
 * family) but returns a plain label and NEVER throws or constructs a provider, so
 * it is safe to call on every recorded usage. Any brain we cannot faithfully price
 * resolves to its own non-priced label — spend is never fake-priced as Anthropic.
 */
export function resolveAttributionProvider(model?: string): ModelProviderId {
  const brain = env('AEGIS_BRAIN')?.toLowerCase();
  if (brain && brain !== 'anthropic') {
    if (brain === 'gemini') return 'gemini';
    if (brain === 'openai') return 'openai';
    if (brain === 'ollama') return 'ollama';
    if (brain === 'cli') return 'cli';
    return 'custom'; // "custom" or any other value → a self-hosted endpoint
  }
  // No override → attribute by the routed model's family (matches providerForModel).
  if (!model || model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'gemini';
  return 'openai'; // gpt-*, o1-*, o3-*, any non-claude/non-gemini id
}
