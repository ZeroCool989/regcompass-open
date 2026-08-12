import { AegisError, type ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';
import type { SystemBlock } from '../modes';
import type {
  ModelProvider,
  ProviderCallParams,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessageParam,
  ProviderMessage,
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
 * Google Gemini backend (Generative Language API). Translates the canonical
 * message/tool shape to and from Gemini `contents`/`parts`/`functionCall`/
 * `functionResponse`. Gemini keys function responses by name, not by a call id,
 * so a pre-pass maps canonical tool_use ids back to their function name.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export type GeminiConfig = {
  id: string;
  label: string;
  baseURL?: string;
  apiKey?: string | null;
};

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function toGeminiTools(tools: ProviderTool[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      function_declarations: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema,
      })),
    },
  ];
}

/** Collect canonical tool_use id → function name across the assistant history. */
function toolNamesById(messages: ProviderMessageParam[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const b of msg.content) {
      const block = b as { type?: string; id?: string; name?: string };
      if (block.type === 'tool_use' && block.id && block.name) map.set(block.id, block.name);
    }
  }
  return map;
}

function toGeminiContents(messages: ProviderMessageParam[]): unknown[] {
  const names = toolNamesById(messages);
  const contents: unknown[] = [];
  for (const msg of messages) {
    const parts: GeminiPart[] = [];
    let role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const b of msg.content) {
        const block = b as {
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
        };
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name ?? '', args: (block.input as Record<string, unknown>) ?? {} } });
        } else if (block.type === 'tool_result') {
          role = 'user';
          const name = names.get(block.tool_use_id ?? '') ?? 'tool';
          const payload =
            typeof block.content === 'string' ? { result: block.content } : { result: block.content ?? null };
          parts.push({ functionResponse: { name, response: payload as Record<string, unknown> } });
        }
      }
    }
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

function partsToBlocks(parts: GeminiPart[] | undefined): ProviderContentBlock[] {
  const blocks: ProviderContentBlock[] = [];
  let text = '';
  for (const p of parts ?? []) {
    if ('text' in p && typeof p.text === 'string') text += p.text;
  }
  if (text) blocks.push(textBlock(text));
  for (const p of parts ?? []) {
    if ('functionCall' in p && p.functionCall) {
      blocks.push(
        toolUseBlock(
          `call_${Math.round(Math.random() * 1e9).toString(36)}`,
          p.functionCall.name,
          p.functionCall.args ?? {},
        ),
      );
    }
  }
  return blocks;
}

export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    promptCache: false,
    toolChoice: false,
    structuredOutput: true,
  };
  private readonly cfg: GeminiConfig;

  constructor(cfg: GeminiConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
  }

  private base(): string {
    return (this.cfg.baseURL ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  private headers(apiKey?: string | null, authToken?: string | null): Record<string, string> {
    // A connected Google subscription supplies an OAuth access token, sent as a
    // Bearer credential rather than the x-goog-api-key header.
    if (authToken) return { authorization: `Bearer ${authToken}` };
    const key = apiKey || this.cfg.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!key) throw new AegisError('internal_error', 'No Google/Gemini API key configured.');
    return { 'x-goog-api-key': key };
  }

  private buildBody(params: ProviderCallParams | { systemBlocks: SystemBlock[]; messages: ProviderMessageParam[]; tools: ProviderTool[]; maxTokens: number }): Record<string, unknown> {
    const system = params.systemBlocks.map((b) => b.text).join('\n\n').trim();
    const body: Record<string, unknown> = {
      contents: toGeminiContents(params.messages),
      generationConfig: { maxOutputTokens: params.maxTokens },
    };
    if (system) body.system_instruction = { parts: [{ text: system }] };
    const tools = toGeminiTools(params.tools);
    if (tools) {
      body.tools = tools;
      // Honour a forced tool-free turn: the loop's degrade / citation-repair
      // passes send toolChoice:{type:'none'} to force a final answer. Gemini's
      // equivalent is functionCallingConfig mode NONE — without it those passes
      // could keep calling tools and never finalise (the D4 forced-answer gap).
      const toolChoice = (params as ProviderCallParams).toolChoice as { type?: string } | undefined;
      if (toolChoice?.type === 'none') {
        body.tool_config = { function_calling_config: { mode: 'NONE' } };
      }
    }
    return body;
  }

  async createMessage(params: ProviderCallParams): Promise<ProviderMessage> {
    const res = await postJson(
      `${this.base()}/models/${params.model}:generateContent`,
      this.headers(params.apiKey, params.authToken),
      this.buildBody(params),
      { providerLabel: this.cfg.label, usedByokKey: !!params.apiKey, signal: params.signal },
    );
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = json.candidates?.[0];
    const content = partsToBlocks(cand?.content?.parts);
    if (content.length === 0) content.push(textBlock(''));
    const hasTool = content.some((c) => (c as { type?: string }).type === 'tool_use');
    return buildCanonicalMessage({
      model: params.model,
      content,
      stopReason: hasTool ? 'tool_use' : mapFinishReason(cand?.finishReason),
      usage: canonicalUsage(
        json.usageMetadata?.promptTokenCount ?? 0,
        json.usageMetadata?.candidatesTokenCount ?? 0,
      ),
    });
  }

  async streamMessage(params: ProviderCallParams): Promise<ProviderMessageStream> {
    const res = await postJson(
      `${this.base()}/models/${params.model}:streamGenerateContent?alt=sse`,
      this.headers(params.apiKey, params.authToken),
      this.buildBody(params),
      { providerLabel: this.cfg.label, usedByokKey: !!params.apiKey, signal: params.signal },
    );
    if (!res.body) throw new AegisError('upstream_error', `${this.cfg.label} returned no stream body.`);
    const model = params.model;

    let textAcc = '';
    // Each tool call carries its id from first sight, so the streamed
    // content_block_start event and the assembled finalMessage() block share the
    // SAME id — the loop pairs tool_result → tool_use by that id, and Gemini's
    // id→name recovery survives the verify-retry / trimForRetry envelope.
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    // Per-stream suffix keeps ids unique across turns without a shared counter.
    const idSuffix = Math.random().toString(36).slice(2, 8);
    let finishReason: string | undefined;
    let usageIn = 0;
    let usageOut = 0;
    let iterated = false;

    async function* iterate(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamEvent> {
      let toolIndex = 0;
      for await (const raw of parseSse(body)) {
        const chunk = raw as {
          candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        if (chunk.usageMetadata) {
          usageIn = chunk.usageMetadata.promptTokenCount ?? usageIn;
          usageOut = chunk.usageMetadata.candidatesTokenCount ?? usageOut;
        }
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finishReason = cand.finishReason;
        for (const p of cand?.content?.parts ?? []) {
          if ('text' in p && typeof p.text === 'string' && p.text.length > 0) {
            textAcc += p.text;
            yield textDeltaEvent(p.text);
          } else if ('functionCall' in p && p.functionCall) {
            toolIndex += 1;
            const id = `gemcall_${toolIndex}_${idSuffix}`;
            toolCalls.push({ id, name: p.functionCall.name, args: p.functionCall.args ?? {} });
            yield toolUseStartEvent(toolIndex, id, p.functionCall.name);
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
        if (!iterated) {
          for await (const _ of iterate(res.body!)) void _;
        }
        const content: ProviderContentBlock[] = [];
        if (textAcc) content.push(textBlock(textAcc));
        for (const tc of toolCalls) {
          content.push(toolUseBlock(tc.id, tc.name, tc.args));
        }
        if (content.length === 0) content.push(textBlock(''));
        return buildCanonicalMessage({
          model,
          content,
          stopReason: toolCalls.length > 0 ? 'tool_use' : mapFinishReason(finishReason),
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
    apiKey?: string | null;
    authToken?: string | null;
  }): Promise<{ text: string; usage: ClaudeUsage }> {
    const msg = await this.createMessage({
      model: params.model,
      systemBlocks: [],
      tools: [],
      messages: [{ role: 'user', content: params.prompt }],
      maxTokens: params.maxTokens,
      apiKey: params.apiKey,
      authToken: params.authToken,
    });
    const text = (msg.content as { type?: string; text?: string }[])
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
    apiKey?: string | null;
    authToken?: string | null;
  }): Promise<{ value: T; usage: ClaudeUsage }> {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        responseMimeType: 'application/json',
        responseSchema: params.schema,
      },
    };
    if (params.system) body.system_instruction = { parts: [{ text: params.system }] };
    const res = await postJson(
      `${this.base()}/models/${params.model}:generateContent`,
      this.headers(params.apiKey, params.authToken),
      body,
      { providerLabel: this.cfg.label },
    );
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = json.candidates?.[0];
    if (cand?.finishReason === 'MAX_TOKENS') {
      throw new AegisError('upstream_error', 'Structured output was truncated (hit max_tokens) — result is incomplete.');
    }
    const text = (cand?.content?.parts ?? [])
      .filter((p): p is { text: string } => 'text' in p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    try {
      return {
        value: JSON.parse(text) as T,
        usage: canonicalUsage(
          json.usageMetadata?.promptTokenCount ?? 0,
          json.usageMetadata?.candidatesTokenCount ?? 0,
        ),
      };
    } catch {
      throw new AegisError('upstream_error', 'Structured output was not valid JSON.');
    }
  }
}
