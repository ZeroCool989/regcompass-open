import type { ModelId } from '../../types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiProvider } from '../gemini';

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
}

function provider() {
  return new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'k' });
}

afterEach(() => vi.restoreAllMocks());

describe('GeminiProvider — translation', () => {
  it('maps system + user turn onto Gemini contents and a text response back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'Hallo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const msg = await provider().createMessage({
      model: 'gemini-2.5-pro' as ModelId,
      systemBlocks: [{ text: 'You are AEGIS.', cached: false }],
      tools: [],
      messages: [{ role: 'user', content: 'Was ist DORA?' }],
      maxTokens: 100,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('models/gemini-2.5-pro:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('k');
    const body = JSON.parse(init.body);
    expect(body.system_instruction).toEqual({ parts: [{ text: 'You are AEGIS.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Was ist DORA?' }] }]);
    expect((msg.content[0] as { text: string }).text).toBe('Hallo');
    expect(msg.usage.input_tokens).toBe(8);
  });

  it('maps a functionCall response to a tool_use block with tool_use stop reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_requirements', args: { id: 'R-DORA-024' } } }] }, finishReason: 'STOP' }], usageMetadata: {} }),
      ),
    );
    const msg = await provider().createMessage({ model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [{ name: 'get_requirements', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    expect(msg.stop_reason).toBe('tool_use');
    const toolUse = msg.content.find((c) => (c as { type: string }).type === 'tool_use') as { name: string; input: unknown };
    expect(toolUse.name).toBe('get_requirements');
    expect(toolUse.input).toEqual({ id: 'R-DORA-024' });
  });

  it('resolves a tool_result back to its function name via the assistant history', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().createMessage({
      model: 'gemini-2.5-pro' as ModelId,
      systemBlocks: [],
      tools: [],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'search_kb', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'R-DORA-001' }] },
      ] as never,
      maxTokens: 100,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const fnResponse = body.contents.flatMap((c: { parts: unknown[] }) => c.parts).find((p: { functionResponse?: unknown }) => p.functionResponse);
    expect(fnResponse.functionResponse.name).toBe('search_kb');
  });
});

// ─────────── Stage 1b-ii-b1 structural parity fixes (adapter stays D4-gated) ───────────

const A_TOOL = { name: 'search_kb', description: 'd', input_schema: { type: 'object' as const } };

function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.close();
    },
  });
}

describe('GeminiProvider — tool_choice enforcement', () => {
  it('translates toolChoice:{type:none} to functionCallingConfig mode NONE (forced tool-free turn)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'final' }] }, finishReason: 'STOP' }], usageMetadata: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await provider().createMessage({
      model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [A_TOOL],
      messages: [{ role: 'user', content: 'x' }], maxTokens: 100, toolChoice: { type: 'none' },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_config).toEqual({
      function_calling_config: { mode: 'NONE' },
    });
  });

  it('sends no tool_config when tools are offered without a none override (default AUTO)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await provider().createMessage({
      model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [A_TOOL],
      messages: [{ role: 'user', content: 'x' }], maxTokens: 100,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tool_config).toBeUndefined();
  });
});

describe('GeminiProvider — canonical refusal handling', () => {
  it('maps a SAFETY finish to a canonical refusal, never a silent clean finish', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }], usageMetadata: {} }),
    ));
    const msg = await provider().createMessage({
      model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 100,
    });
    expect(msg.stop_reason).toBe('refusal');
  });
});

describe('GeminiProvider — cancellation', () => {
  it('forwards the abort signal to fetch and surfaces a cancelled state without retrying', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    vi.stubGlobal('fetch', fetchMock);
    ctrl.abort();
    await expect(
      provider().createMessage({
        model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 100, signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(fetchMock.mock.calls[0][1].signal).toBe(ctrl.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on cancellation
  });
});

describe('GeminiProvider — stable tool-call ids (streaming)', () => {
  it('uses the SAME id in the content_block_start event and the assembled finalMessage()', async () => {
    const body = sseStream([
      { candidates: [{ content: { parts: [{ functionCall: { name: 'search_kb', args: { q: 'dora' } } }] } }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body } as unknown as Response));

    const stream = await provider().streamMessage({
      model: 'gemini-2.5-pro' as ModelId, systemBlocks: [], tools: [A_TOOL], messages: [{ role: 'user', content: 'x' }], maxTokens: 100,
    });
    let startedId: string | undefined;
    for await (const ev of stream) {
      const e = ev as { type?: string; content_block?: { type?: string; id?: string } };
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') startedId = e.content_block.id;
    }
    const final = await stream.finalMessage();
    const toolUse = final.content.find((c) => (c as { type?: string }).type === 'tool_use') as { id: string };
    expect(startedId).toBeDefined();
    expect(toolUse.id).toBe(startedId);
  });
});
