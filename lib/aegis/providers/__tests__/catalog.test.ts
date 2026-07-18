import { afterEach, describe, expect, it } from 'vitest';
import { activeOAuthProviderId, resolveProvider } from '../catalog';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('resolveProvider — selection by model family', () => {
  it('routes claude ids to the Anthropic backend (default, unchanged)', () => {
    delete process.env.AEGIS_BRAIN;
    expect(resolveProvider('claude-sonnet-4-6').id).toBe('anthropic');
    expect(resolveProvider(undefined).id).toBe('anthropic');
  });

  it('routes gpt ids to the OpenAI backend and gemini ids to Gemini', () => {
    delete process.env.AEGIS_BRAIN;
    expect(resolveProvider('gpt-4.1').id).toBe('openai');
    expect(resolveProvider('gemini-2.5-pro').id).toBe('gemini');
  });
});

describe('resolveProvider — global AEGIS_BRAIN override', () => {
  it('points every call at a self-hosted OpenAI-compatible endpoint', () => {
    process.env.AEGIS_BRAIN = 'custom';
    process.env.OPENAI_COMPAT_BASE_URL = 'https://hermes.example.com/v1';
    process.env.OPENAI_COMPAT_MODEL = 'hermes-1';
    // Even when the router picks a claude id, the override wins.
    const p = resolveProvider('claude-sonnet-4-6');
    expect(p.id).toBe('custom');
  });

  it('supports an Ollama override with local defaults', () => {
    process.env.AEGIS_BRAIN = 'ollama';
    const p = resolveProvider('claude-sonnet-4-6');
    expect(p.id).toBe('ollama');
    expect(p.capabilities.promptCache).toBe(false);
  });
});

describe('resolveProvider — CLI bridge brain', () => {
  it('selects the CLI bridge when AEGIS_BRAIN=cli with a command', () => {
    process.env.AEGIS_BRAIN = 'cli';
    process.env.AEGIS_CLI_COMMAND = 'claude';
    const p = resolveProvider('claude-sonnet-4-6');
    expect(p.id).toBe('cli:claude');
    expect(p.capabilities.toolChoice).toBe(false);
  });

  it('errors clearly when AEGIS_BRAIN=cli but no command is set', () => {
    process.env.AEGIS_BRAIN = 'cli';
    delete process.env.AEGIS_CLI_COMMAND;
    expect(() => resolveProvider('claude-sonnet-4-6')).toThrow(/AEGIS_CLI_COMMAND/);
  });
});

describe('activeOAuthProviderId — which subscription backs the active brain', () => {
  it('maps model families to subscription providers', () => {
    delete process.env.AEGIS_BRAIN;
    expect(activeOAuthProviderId('claude-sonnet-4-6')).toBe('anthropic');
    expect(activeOAuthProviderId(undefined)).toBe('anthropic');
    expect(activeOAuthProviderId('gemini-2.5-pro')).toBe('google');
    expect(activeOAuthProviderId('gpt-5')).toBe('openai');
  });

  it('honors the AEGIS_BRAIN override, and has no subscription for local/self-hosted', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    expect(activeOAuthProviderId('claude-sonnet-4-6')).toBe('google');
    process.env.AEGIS_BRAIN = 'openai';
    expect(activeOAuthProviderId('claude-sonnet-4-6')).toBe('openai');
    process.env.AEGIS_BRAIN = 'ollama';
    expect(activeOAuthProviderId('claude-sonnet-4-6')).toBeNull();
    process.env.AEGIS_BRAIN = 'custom';
    expect(activeOAuthProviderId('claude-sonnet-4-6')).toBeNull();
  });
});
