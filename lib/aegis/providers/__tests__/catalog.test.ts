import { afterEach, describe, expect, it } from 'vitest';
import {
  activeOAuthProviderId,
  providerForSelection,
  resolveAttributionProvider,
  resolveProvider,
} from '../catalog';

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

describe('providerForSelection — an explicit selection ignores AEGIS_BRAIN', () => {
  it('dispatches Anthropic for an anthropic selection even when AEGIS_BRAIN=gemini', () => {
    process.env.AEGIS_BRAIN = 'gemini';
    expect(providerForSelection('anthropic').id).toBe('anthropic');
  });

  it('dispatches Gemini for a gemini selection even when AEGIS_BRAIN=ollama', () => {
    process.env.AEGIS_BRAIN = 'ollama';
    expect(providerForSelection('gemini').id).toBe('gemini');
  });
});

describe('resolveAttributionProvider — cost label for the served brain', () => {
  it('attributes by model family when no override is set', () => {
    delete process.env.AEGIS_BRAIN;
    expect(resolveAttributionProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(resolveAttributionProvider(undefined)).toBe('anthropic');
    expect(resolveAttributionProvider('gemini-2.5-pro')).toBe('gemini');
    expect(resolveAttributionProvider('gpt-5')).toBe('openai');
  });

  it('honors the AEGIS_BRAIN override for every model id (override wins)', () => {
    for (const [brain, expected] of [
      ['gemini', 'gemini'],
      ['openai', 'openai'],
      ['ollama', 'ollama'],
      ['cli', 'cli'],
      ['custom', 'custom'],
      ['anything-else', 'custom'],
    ] as const) {
      process.env.AEGIS_BRAIN = brain;
      // Even a claude id is attributed to the override brain, not Anthropic.
      expect(resolveAttributionProvider('claude-sonnet-4-6')).toBe(expected);
    }
  });

  it('never throws — even for AEGIS_BRAIN=cli with no command configured', () => {
    process.env.AEGIS_BRAIN = 'cli';
    delete process.env.AEGIS_CLI_COMMAND;
    // resolveProvider would throw here; the attribution label must not.
    expect(() => resolveAttributionProvider('claude-sonnet-4-6')).not.toThrow();
    expect(resolveAttributionProvider('claude-sonnet-4-6')).toBe('cli');
  });

  it('stays in lockstep with the brain resolveProvider actually dispatches to', () => {
    // The attribution label must track the real brain id, so cost is never
    // pinned to a different provider than the one that served the call.
    const brainIdToAttribution: Record<string, string> = {
      anthropic: 'anthropic',
      gemini: 'gemini',
      openai: 'openai',
      ollama: 'ollama',
      custom: 'custom',
      'cli:claude': 'cli',
    };
    const cases: Array<{ brain?: string; model: string; cliCommand?: string }> = [
      { model: 'claude-sonnet-4-6' }, // no override → anthropic
      { model: 'gpt-4.1' }, // no override → openai
      { model: 'gemini-2.5-pro' }, // no override → gemini
      { brain: 'ollama', model: 'claude-sonnet-4-6' },
      { brain: 'custom', model: 'claude-sonnet-4-6' },
      { brain: 'cli', cliCommand: 'claude', model: 'claude-sonnet-4-6' },
    ];
    for (const c of cases) {
      if (c.brain) process.env.AEGIS_BRAIN = c.brain;
      else delete process.env.AEGIS_BRAIN;
      if (c.cliCommand) process.env.AEGIS_CLI_COMMAND = c.cliCommand;
      const brainId = resolveProvider(c.model).id;
      expect(resolveAttributionProvider(c.model)).toBe(brainIdToAttribution[brainId]);
    }
  });
});
