import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getProvider } from '../providers/registry';
import { AnthropicProvider } from '../providers/anthropic';
import type { ProviderCallParams } from '../providers/types';

describe('provider registry', () => {
  it('resolves the Anthropic reference backend', () => {
    const p = getProvider();
    expect(p.id).toBe('anthropic');
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('declares the reference backend capabilities', () => {
    expect(getProvider().capabilities).toEqual({
      promptCache: true,
      toolChoice: true,
      structuredOutput: true,
    });
  });
});

describe('client facade delegates to the selected provider', () => {
  beforeEach(() => vi.resetModules());

  it('routes callClaude through getProvider().createMessage with identical params', async () => {
    const params = {
      model: 'm',
      systemBlocks: [],
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    } as unknown as ProviderCallParams;

    const fakeMessage = { id: 'x' };
    const createMessage = vi.fn().mockResolvedValue(fakeMessage);
    vi.doMock('../providers/registry', () => ({
      getProvider: () => ({ id: 'fake', createMessage }),
    }));

    const { callClaude } = await import('../client');
    const out = await callClaude(params);

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(params);
    expect(out).toBe(fakeMessage);
    vi.doUnmock('../providers/registry');
  });
});
