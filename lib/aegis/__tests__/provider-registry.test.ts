import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { getProvider, getProviderFor } from '../providers/registry';
import { AnthropicProvider } from '../providers/anthropic';
import type { ProviderCallParams } from '../providers/types';

describe('getProviderFor — a user selection cannot be overridden by env', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('honours an explicit Anthropic selection even when AEGIS_BRAIN=gemini is set', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    expect(getProviderFor('anthropic', 'claude-sonnet-4-6').id).toBe('anthropic');
  });

  it('honours an explicit Gemini selection', () => {
    delete process.env.AEGIS_BRAIN;
    expect(getProviderFor('gemini', 'claude-sonnet-4-6').id).toBe('gemini');
  });

  it('falls back to the AEGIS_BRAIN escape hatch ONLY when no provider is threaded', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    expect(getProviderFor(undefined, 'claude-sonnet-4-6').id).toBe('gemini');
    delete process.env.AEGIS_BRAIN;
    expect(getProviderFor(undefined, 'claude-sonnet-4-6').id).toBe('anthropic');
  });
});

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
      // No explicit provider on params → callClaude uses getProviderFor(undefined, model).
      getProviderFor: () => ({ id: 'fake', createMessage }),
    }));

    const { callClaude } = await import('../client');
    const out = await callClaude(params);

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith(params);
    expect(out).toBe(fakeMessage);
    vi.doUnmock('../providers/registry');
  });
});
