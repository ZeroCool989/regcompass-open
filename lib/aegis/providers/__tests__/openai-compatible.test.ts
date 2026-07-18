import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleProvider } from '../openai-compatible';

/** Build a mock fetch Response carrying a JSON body. */
function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** Build a mock streaming Response from SSE data payloads. */
function sseResponse(chunks: unknown[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body } as unknown as Response;
}

function provider() {
  return new OpenAiCompatibleProvider({
    id: 'test',
    label: 'Test',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'k',
  });
}

afterEach(() => vi.restoreAllMocks());

describe('OpenAiCompatibleProvider — request translation', () => {
  it('maps system blocks + user turn onto OpenAI messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ model: 'm', choices: [{ message: { content: 'Hallo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const msg = await provider().createMessage({
      model: 'gpt-x',
      systemBlocks: [{ text: 'You are AEGIS.', cached: true }],
      tools: [],
      messages: [{ role: 'user', content: 'Was ist DORA?' }],
      maxTokens: 100,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are AEGIS.' },
      { role: 'user', content: 'Was ist DORA?' },
    ]);
    expect((msg.content[0] as { text: string }).text).toBe('Hallo');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage.input_tokens).toBe(10);
    expect(msg.usage.output_tokens).toBe(5);
  });

  it('round-trips an assistant tool_use + user tool_result into OpenAI tool_calls / role:tool', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider().createMessage({
      model: 'gpt-x',
      systemBlocks: [],
      tools: [{ name: 'search_kb', description: 'd', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'find DORA' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'search_kb', input: { q: 'DORA' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'R-DORA-001' }] },
      ] as never,
      maxTokens: 100,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'search_kb', description: 'd', parameters: { type: 'object' } } });
    const assistant = body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'search_kb' } });
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'R-DORA-001' });
  });

  it('parses a tool_calls response into a canonical tool_use block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'get_requirements', arguments: '{"id":"R-DORA-024"}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      ),
    );
    const msg = await provider().createMessage({ model: 'gpt-x', systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    expect(msg.stop_reason).toBe('tool_use');
    const toolUse = msg.content.find((c) => (c as { type: string }).type === 'tool_use') as { name: string; input: unknown };
    expect(toolUse.name).toBe('get_requirements');
    expect(toolUse.input).toEqual({ id: 'R-DORA-024' });
  });
});

describe('OpenAiCompatibleProvider — streaming', () => {
  it('assembles fragmented tool-call argument deltas and emits canonical events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          { choices: [{ delta: { content: 'Analyse' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'search_kb' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"DO' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'RA"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 4 } },
        ]),
      ),
    );

    const stream = await provider().streamMessage({ model: 'gpt-x', systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    const types: string[] = [];
    for await (const ev of stream) {
      types.push(ev.type);
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') expect(ev.delta.text).toBe('Analyse');
    }
    expect(types).toEqual(['content_block_delta', 'content_block_start']);

    const final = await stream.finalMessage();
    expect((final.content[0] as { text: string }).text).toBe('Analyse');
    const toolUse = final.content.find((c) => (c as { type: string }).type === 'tool_use') as { name: string; input: unknown };
    expect(toolUse.name).toBe('search_kb');
    expect(toolUse.input).toEqual({ q: 'DORA' });
    expect(final.stop_reason).toBe('tool_use');
    expect(final.usage.input_tokens).toBe(7);
  });
});

describe('OpenAiCompatibleProvider — structured', () => {
  it('requests json_schema and parses the JSON result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '{"mode":"ASSESS","score":3}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 6 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { value } = await provider().structured<{ mode: string; score: number }>({
      model: 'gpt-x',
      system: 'sys',
      prompt: 'classify',
      schema: { type: 'object' },
      maxTokens: 100,
    });
    expect(value).toEqual({ mode: 'ASSESS', score: 3 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
  });
});
