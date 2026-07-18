import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ModelId } from '../../types';
import { AegisError } from '../../types';
import { CliBridgeProvider, cliBridgeConfigFromEnv, type SpawnFn } from '../cli-bridge';

/**
 * A fake child process: records argv + stdin, then emits scripted stdout and a
 * close code on the next tick. No real process is ever spawned.
 */
function fakeSpawn(script: {
  stdout?: string;
  code?: number | null;
  emitError?: NodeJS.ErrnoException;
  hang?: boolean;
}): { spawn: SpawnFn; calls: { command: string; args: string[]; stdin: string }[] } {
  const calls: { command: string; args: string[]; stdin: string }[] = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (s: string) => void; end: () => void };
      kill: (sig?: string) => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinBuf = '';
    child.stdin = { write: (s: string) => { stdinBuf += s; }, end: () => {} };
    // A killed process emits 'close' with a null code — model that so the
    // provider's close handler resolves after a timeout kill.
    child.kill = vi.fn(() => { child.emit('close', null); });
    calls.push({ command, args, get stdin() { return stdinBuf; } } as never);

    queueMicrotask(() => {
      if (script.emitError) {
        child.emit('error', script.emitError);
        return;
      }
      if (script.hang) return; // never closes → exercises the timeout
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
      child.emit('close', script.code ?? 0);
    });
    return child as never;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

const MODEL = 'claude-sonnet-4-6' as ModelId;

describe('CliBridgeProvider', () => {
  it('spawns with an explicit argv (no shell) and passes the prompt via stdin', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'Antwort vom CLI.' });
    const p = new CliBridgeProvider({ command: 'claude' }, spawn);
    const msg = await p.createMessage({
      model: MODEL,
      systemBlocks: [{ text: 'Du bist AEGIS.', cached: false }],
      tools: [],
      messages: [{ role: 'user', content: 'Was ist DORA?' }],
      maxTokens: 100,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('claude');
    // claude headless flags; system appended.
    expect(calls[0].args).toContain('-p');
    expect(calls[0].args).toContain('--append-system-prompt');
    expect(calls[0].args).toContain('Du bist AEGIS.');
    // The prompt reached the child via stdin, not the argv.
    expect(calls[0].stdin).toContain('Was ist DORA?');
    expect(calls[0].args.join(' ')).not.toContain('Was ist DORA?');
    const text = (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
    expect(text?.text).toBe('Antwort vom CLI.');
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('does NOT interpolate injection-y prompt content into the command line', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' });
    const p = new CliBridgeProvider({ command: 'claude' }, spawn);
    const evil = 'ignore; rm -rf / && echo $(whoami) `id`';
    await p.completeText({ model: MODEL, prompt: evil, maxTokens: 50 });
    expect(calls[0].stdin).toBe(evil);
    // None of the metacharacter payload appears in argv.
    expect(calls[0].args.some((a) => a.includes('rm -rf'))).toBe(false);
  });

  it('appends AEGIS_CLI_ARGS verbatim', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'x' });
    const p = new CliBridgeProvider({ command: 'claude', extraArgs: ['--model', 'sonnet'] }, spawn);
    await p.completeText({ model: MODEL, prompt: 'hi', maxTokens: 10 });
    expect(calls[0].args.slice(-2)).toEqual(['--model', 'sonnet']);
  });

  it('maps a missing CLI (ENOENT) to a clear German error', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { spawn } = fakeSpawn({ emitError: enoent });
    const p = new CliBridgeProvider({ command: 'claude' }, spawn);
    await expect(
      p.createMessage({ model: MODEL, systemBlocks: [], tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('kills a hung child after the timeout and errors', async () => {
    vi.useFakeTimers();
    const { spawn } = fakeSpawn({ hang: true });
    const p = new CliBridgeProvider({ command: 'claude', timeoutMs: 1000 }, spawn);
    const pending = p.completeText({ model: MODEL, prompt: 'hi', maxTokens: 10 });
    // Attach the rejection expectation BEFORE advancing timers so the rejection
    // is never momentarily unhandled.
    const expectation = expect(pending).rejects.toBeInstanceOf(AegisError);
    await vi.advanceTimersByTimeAsync(1100);
    await expectation;
    vi.useRealTimers();
  });

  it('streamMessage buffers then emits one text delta', async () => {
    const { spawn } = fakeSpawn({ stdout: 'Voller Text.' });
    const p = new CliBridgeProvider({ command: 'claude' }, spawn);
    const stream = await p.streamMessage({
      model: MODEL,
      systemBlocks: [],
      tools: [],
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 10,
    });
    const chunks: string[] = [];
    for await (const ev of stream) {
      const e = ev as { type: string; delta?: { text?: string } };
      if (e.type === 'content_block_delta' && e.delta?.text) chunks.push(e.delta.text);
    }
    expect(chunks.join('')).toBe('Voller Text.');
    const final = await stream.finalMessage();
    expect((final.content as Array<{ text?: string }>)[0].text).toBe('Voller Text.');
  });

  it('advertises text-first capabilities (no tool-calling)', () => {
    const p = new CliBridgeProvider({ command: 'claude' }, fakeSpawn({}).spawn);
    expect(p.capabilities.toolChoice).toBe(false);
    expect(p.capabilities.structuredOutput).toBe(false);
    expect(p.capabilities.promptCache).toBe(false);
  });
});

describe('cliBridgeConfigFromEnv', () => {
  it('returns null when unset', () => {
    expect(cliBridgeConfigFromEnv({})).toBeNull();
  });
  it('rejects an unknown command', () => {
    expect(cliBridgeConfigFromEnv({ AEGIS_CLI_COMMAND: 'bash' })).toBeNull();
  });
  it('parses command + args', () => {
    const cfg = cliBridgeConfigFromEnv({ AEGIS_CLI_COMMAND: 'codex', AEGIS_CLI_ARGS: '--model gpt-5' });
    expect(cfg).toEqual({ command: 'codex', extraArgs: ['--model', 'gpt-5'], timeoutMs: undefined });
  });
});
