import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { brainKind, commandExistsOnPath, getBrainStatus } from '@/lib/aegis/brain-status';

describe('brainKind', () => {
  it('defaults to anthropic when unset or explicit', () => {
    expect(brainKind({})).toBe('anthropic');
    expect(brainKind({ AEGIS_BRAIN: 'anthropic' })).toBe('anthropic');
    expect(brainKind({ AEGIS_BRAIN: '  ' })).toBe('anthropic');
  });

  it('maps known brains and falls back to custom', () => {
    expect(brainKind({ AEGIS_BRAIN: 'cli' })).toBe('cli');
    expect(brainKind({ AEGIS_BRAIN: 'OpenAI' })).toBe('openai');
    expect(brainKind({ AEGIS_BRAIN: 'gemini' })).toBe('gemini');
    expect(brainKind({ AEGIS_BRAIN: 'ollama' })).toBe('ollama');
    expect(brainKind({ AEGIS_BRAIN: 'something-else' })).toBe('custom');
  });
});

describe('commandExistsOnPath', () => {
  it('rejects names containing path separators (no fs traversal)', () => {
    expect(commandExistsOnPath('../evil', { PATH: '/usr/bin' })).toBe(false);
    expect(commandExistsOnPath('a/b', { PATH: '/usr/bin' })).toBe(false);
    expect(commandExistsOnPath('', { PATH: '/usr/bin' })).toBe(false);
  });

  it('finds a real executable that exists on PATH', () => {
    // `node` is running this test, so its dir is a stable PATH entry to probe.
    const dir = dirname(process.execPath);
    expect(commandExistsOnPath('node', { PATH: dir })).toBe(true);
  });

  it('returns false when the command is absent', () => {
    expect(commandExistsOnPath('definitely-not-a-real-cli-xyz', { PATH: '/usr/bin' })).toBe(false);
  });
});

describe('getBrainStatus', () => {
  it('reports anthropic with no CLI when unset', () => {
    const s = getBrainStatus({});
    expect(s.brain).toBe('anthropic');
    expect(s.cli).toEqual({ command: null, active: false, onPath: false });
  });

  it('marks the CLI active when AEGIS_BRAIN=cli and a valid command is set', () => {
    const s = getBrainStatus({ AEGIS_BRAIN: 'cli', AEGIS_CLI_COMMAND: 'claude', PATH: '' });
    expect(s.brain).toBe('cli');
    expect(s.cli.command).toBe('claude');
    expect(s.cli.active).toBe(true);
    expect(s.cli.onPath).toBe(false); // empty PATH → not found, but still active/configured
  });

  it('is not active when AEGIS_BRAIN=cli but the command is invalid', () => {
    const s = getBrainStatus({ AEGIS_BRAIN: 'cli', AEGIS_CLI_COMMAND: 'bogus' });
    expect(s.cli.active).toBe(false);
    expect(s.cli.command).toBe(null);
  });
});
