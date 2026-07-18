import type { ModelProvider } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { GeminiProvider } from './gemini';

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
