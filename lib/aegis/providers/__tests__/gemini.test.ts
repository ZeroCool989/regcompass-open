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
      model: 'gemini-2.5-pro',
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
    const msg = await provider().createMessage({ model: 'gemini-2.5-pro', systemBlocks: [], tools: [{ name: 'get_requirements', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
    expect(msg.stop_reason).toBe('tool_use');
    const toolUse = msg.content.find((c) => (c as { type: string }).type === 'tool_use') as { name: string; input: unknown };
    expect(toolUse.name).toBe('get_requirements');
    expect(toolUse.input).toEqual({ id: 'R-DORA-024' });
  });

  it('resolves a tool_result back to its function name via the assistant history', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().createMessage({
      model: 'gemini-2.5-pro',
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
