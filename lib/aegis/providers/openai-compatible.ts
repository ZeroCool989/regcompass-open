import { AegisError, type ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';
import type { SystemBlock } from '../modes';
import type {
  ModelProvider,
  ProviderCallParams,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderMessageParam,
  ProviderMessageStream,
  ProviderStreamEvent,
  ProviderTool,
} from './types';
import {
  buildCanonicalMessage,
  canonicalUsage,
  mapFinishReason,
  parseSse,
  postJson,
  textBlock,
  textDeltaEvent,
  toolUseBlock,
  toolUseStartEvent,
} from './canonical';

/**
 * OpenAI-compatible backend: any endpoint speaking the Chat Completions API —
 * OpenAI, Together, Groq, DeepInfra, OpenRouter, a local Ollama server, or a
 * self-hosted gateway. Configured by baseURL + key; the model id is passed per
 * call. Translates the canonical message/tool shape to and from the Chat
 * Completions wire format.
 */

export type OpenAiCompatibleConfig = {
  /** Backend id used by the registry/logs, e.g. "openai", "ollama", "custom". */
  id: string;
  /** Human label for error messages. */
  label: string;
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseURL: string;
  /** Default API key (env-backed). A per-call BYOK key overrides it. */
  apiKey?: string | null;
  /** Whether the endpoint honors response_format json_schema. */
  structuredOutput?: boolean;
  /**
   * Fixed model id to send regardless of the caller's routed model. Set when
   * this backend is a global brain override (e.g. a self-hosted endpoint whose
   * only model differs from the app's routed ids).
   */
  modelOverride?: string;
};

type OpenAiToolCall = {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
};

/** Loose view over canonical content blocks (the strict SDK union hides fields adapters need). */
type LooseBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
};

// ─────────────────── canonical → OpenAI ───────────────────

function toOpenAiTools(tools: ProviderTool[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema,
    },
  }));
}

function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as LooseBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Translate canonical system blocks + message history into OpenAI messages. */
function toOpenAiMessages(systemBlocks: SystemBlock[], messages: ProviderMessageParam[]): unknown[] {
  const out: unknown[] = [];
  const system = systemBlocks.map((b) => b.text).join('\n\n').trim();
  if (system) out.push({ role: 'system', content: system });

  for (const msg of messages) {
    const content = msg.content;
    if (msg.role === 'user') {
      // Tool results must be their own `tool` messages; plain text stays a user turn.
      if (typeof content === 'string') {
        out.push({ role: 'user', content });
        continue;
      }
      const blocks = content as LooseBlock[];
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === 'string'
              ? tr.content
              : blocksToText(tr.content) || JSON.stringify(tr.content),
        });
      }
      const text = blocksToText(content);
      if (text) out.push({ role: 'user', content: text });
    } else {
      // assistant
      if (typeof content === 'string') {
        out.push({ role: 'assistant', content });
        continue;
      }
      const blocks = content as LooseBlock[];
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const text = blocksToText(content);
      const entry: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }));
      }
      out.push(entry);
    }
  }
  return out;
}

// ─────────────────── OpenAI → canonical ───────────────────

function toolCallsToBlocks(toolCalls: OpenAiToolCall[]): ProviderContentBlock[] {
  return toolCalls
    .filter((tc) => tc.function?.name)
    .map((tc) => {
      let input: unknown = {};
      const raw = tc.function?.arguments;
      if (raw) {
        try {
          input = JSON.parse(raw);
        } catch {
          input = {};
        }
      }
      return toolUseBlock(tc.id ?? `call_${Math.round(Math.random() * 1e9).toString(36)}`, tc.function!.name!, input);
    });
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly cfg: OpenAiCompatibleConfig;

  constructor(cfg: OpenAiCompatibleConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.capabilities = {
      promptCache: false,
      toolChoice: true,
      structuredOutput: cfg.structuredOutput ?? true,
    };
  }

  private headers(apiKey?: string | null): Record<string, string> {
    const key = apiKey || this.cfg.apiKey;
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  private url(path: string): string {
    return `${this.cfg.baseURL.replace(/\/$/, '')}${path}`;
  }

  async createMessage(params: ProviderCallParams): Promise<ProviderMessage> {
    const body: Record<string, unknown> = {
      model: this.cfg.modelOverride ?? params.model,
      messages: toOpenAiMessages(params.systemBlocks, params.messages),
      max_tokens: params.maxTokens,
    };
    const tools = toOpenAiTools(params.tools);
    if (tools) body.tools = tools;
    if (params.toolChoice && (params.toolChoice as { type?: string }).type === 'none') body.tool_choice = 'none';

    const res = await postJson(this.url('/chat/completions'), this.headers(params.apiKey), body, {
      providerLabel: this.cfg.label,
      usedByokKey: !!params.apiKey,
    });
    const json = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const content: ProviderContentBlock[] = [];
    const text = choice?.message?.content;
    if (text) content.push(textBlock(text));
    const toolCalls = choice?.message?.tool_calls ?? [];
    if (toolCalls.length > 0) content.push(...toolCallsToBlocks(toolCalls));
    if (content.length === 0) content.push(textBlock(''));

    return buildCanonicalMessage({
      model: json.model ?? params.model,
      content,
      stopReason: mapFinishReason(choice?.finish_reason),
      usage: canonicalUsage(json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0),
    });
  }

  async streamMessage(params: ProviderCallParams): Promise<ProviderMessageStream> {
    const body: Record<string, unknown> = {
      model: this.cfg.modelOverride ?? params.model,
      messages: toOpenAiMessages(params.systemBlocks, params.messages),
      max_tokens: params.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = toOpenAiTools(params.tools);
    if (tools) body.tools = tools;
    if (params.toolChoice && (params.toolChoice as { type?: string }).type === 'none') body.tool_choice = 'none';

    const res = await postJson(this.url('/chat/completions'), this.headers(params.apiKey), body, {
      providerLabel: this.cfg.label,
      usedByokKey: !!params.apiKey,
    });
    if (!res.body) throw new AegisError('upstream_error', `${this.cfg.label} returned no stream body.`);

    const model = this.cfg.modelOverride ?? params.model;

    // Assembler state shared between the iterator and finalMessage().
    let textAcc = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usageIn = 0;
    let usageOut = 0;
    let iterated = false;

    async function* iterate(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
      const startedTools = new Set<number>();
      let nextIndex = 0;
      for await (const raw of parseSse(body)) {
        const chunk = raw as {
          choices?: { delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (chunk.usage) {
          usageIn = chunk.usage.prompt_tokens ?? usageIn;
          usageOut = chunk.usage.completion_tokens ?? usageOut;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          textAcc += delta.content;
          yield textDeltaEvent(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let entry = toolAcc.get(idx);
          if (!entry) {
            entry = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', args: '' };
            toolAcc.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          if (entry.name && !startedTools.has(idx)) {
            startedTools.add(idx);
            yield toolUseStartEvent(++nextIndex, entry.id, entry.name);
          }
        }
      }
    }

    const stream: ProviderMessageStream = {
      [Symbol.asyncIterator]() {
        iterated = true;
        return iterate(res.body!)[Symbol.asyncIterator]();
      },
      async finalMessage(): Promise<ProviderMessage> {
        // If the caller never iterated, drain the stream so state is populated.
        if (!iterated) {
          for await (const _ of iterate(res.body!)) {
            void _;
          }
        }
        const content: ProviderContentBlock[] = [];
        if (textAcc) content.push(textBlock(textAcc));
        for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
          if (!tc.name) continue;
          let input: unknown = {};
          if (tc.args) {
            try {
              input = JSON.parse(tc.args);
            } catch {
              input = {};
            }
          }
          content.push(toolUseBlock(tc.id, tc.name, input));
        }
        if (content.length === 0) content.push(textBlock(''));
        return buildCanonicalMessage({
          model,
          content,
          stopReason: mapFinishReason(finishReason ?? (toolAcc.size > 0 ? 'tool_calls' : 'stop')),
          usage: canonicalUsage(usageIn, usageOut),
        });
      },
    };
    return stream;
  }

  async completeText(params: {
    model: ModelId;
    prompt: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: ClaudeUsage }> {
    const msg = await this.createMessage({
      model: params.model,
      systemBlocks: [],
      tools: [],
      messages: [{ role: 'user', content: params.prompt }],
      maxTokens: params.maxTokens,
    });
    const text = (msg.content as LooseBlock[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, usage: msg.usage };
  }

  async structured<T>(params: {
    model: ModelId;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens: number;
  }): Promise<{ value: T; usage: ClaudeUsage }> {
    const messages: unknown[] = [];
    if (params.system) messages.push({ role: 'system', content: params.system });
    messages.push({ role: 'user', content: params.prompt });
    const body: Record<string, unknown> = {
      model: this.cfg.modelOverride ?? params.model,
      messages,
      max_tokens: params.maxTokens,
    };
    if (this.capabilities.structuredOutput) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'structured_output', schema: params.schema, strict: true },
      };
    } else {
      messages[messages.length - 1] = {
        role: 'user',
        content: `${params.prompt}\n\nRespond with ONLY valid JSON matching this schema:\n${JSON.stringify(params.schema)}`,
      };
    }
    const res = await postJson(this.url('/chat/completions'), this.headers(), body, {
      providerLabel: this.cfg.label,
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new AegisError('upstream_error', 'Structured output was truncated (hit max_tokens) — result is incomplete.');
    }
    const text = (choice?.message?.content ?? '').trim();
    try {
      return {
        value: JSON.parse(text) as T,
        usage: canonicalUsage(json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0),
      };
    } catch {
      throw new AegisError('upstream_error', 'Structured output was not valid JSON.');
    }
  }
}
