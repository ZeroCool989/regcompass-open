import { spawn } from 'node:child_process';
import { AegisError, type ModelId } from '../types';
import type { ClaudeUsage } from '../context/cost';
import type { SystemBlock } from '../modes';
import type {
  ModelProvider,
  ProviderCallParams,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderMessageParam,
  ProviderMessageStream,
  ProviderStreamEvent,
} from './types';
import { buildCanonicalMessage, canonicalUsage, textBlock, textDeltaEvent } from './canonical';

/**
 * CLI-bridge backend: drive a locally-installed agent CLI as the brain by
 * spawning it in non-interactive (headless) mode. For users already signed in
 * to `claude` (Claude Code), `codex` (Codex CLI) or `gemini` (Gemini CLI) who
 * want zero API-key/OAuth setup — the CLI carries its own auth.
 *
 * TEXT-FIRST, by design. A headless CLI returns plain text, not structured
 * function calls, so this backend advertises `toolChoice: false`: AEGIS uses it
 * for conversational answers and report generation, not the KB tool loop. The
 * canonical message history is flattened into one prompt (system + transcript),
 * the CLI runs, and stdout becomes a single canonical assistant text message.
 *
 * SECURITY: the CLI is spawned with an explicit argv array (never a shell
 * string) and the prompt is written to the child's STDIN — prompt content is
 * never interpolated into a command line, so it cannot inject flags or shell
 * metacharacters. A hard timeout kills a stuck child.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

type CliName = 'claude' | 'codex' | 'gemini';

/** Per-CLI headless invocation. The prompt always arrives on STDIN. */
type CliSpec = {
  /** argv AFTER the command name; `{system}` is substituted, prompt goes to stdin. */
  args(systemPrompt: string, model: string): string[];
};

const CLI_SPECS: Record<CliName, CliSpec> = {
  // `claude -p` reads the prompt from stdin and prints the reply; text output,
  // system prompt appended, model selected. (`claude --help`: -p/--print,
  // --output-format text, --append-system-prompt, --model.)
  claude: {
    args(systemPrompt) {
      const a = ['-p', '--output-format', 'text'];
      if (systemPrompt) a.push('--append-system-prompt', systemPrompt);
      return a;
    },
  },
  // `codex exec` is the non-interactive form; prompt on stdin.
  codex: {
    args() {
      return ['exec'];
    },
  },
  // `gemini -p` / stdin prompt.
  gemini: {
    args() {
      return ['-p'];
    },
  },
};

export type CliBridgeConfig = {
  /** Which installed CLI to drive. */
  command: CliName;
  /** Extra argv appended verbatim (from AEGIS_CLI_ARGS), e.g. a --model flag. */
  extraArgs?: string[];
  /** Hard timeout before the child is killed. */
  timeoutMs?: number;
};

function flattenPrompt(systemBlocks: SystemBlock[], messages: ProviderMessageParam[]): { system: string; prompt: string } {
  const system = systemBlocks.map((b) => b.text).join('\n\n').trim();
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content as Array<{ type?: string; text?: string; content?: unknown }>)
            .map((b) => {
              if (b.type === 'text') return b.text ?? '';
              if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
              return '';
            })
            .filter(Boolean)
            .join('\n');
    if (text.trim()) lines.push(`${role}: ${text.trim()}`);
  }
  return { system, prompt: lines.join('\n\n') };
}

/** Result of one headless CLI run. */
type CliRun = { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: Error };

/** Spawn hook — overridable in tests so no real process is launched. */
export type SpawnFn = typeof spawn;

function runCli(
  cfg: CliBridgeConfig,
  argv: string[],
  stdin: string,
  spawnImpl: SpawnFn,
): Promise<CliRun> {
  return new Promise<CliRun>((resolve) => {
    let child;
    try {
      // Explicit argv, no shell — prompt content cannot inject flags/metacharacters.
      child = spawnImpl(cfg.command, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: err as Error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    // Prompt to STDIN, then close it.
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

function assertOk(cfg: CliBridgeConfig, run: CliRun): string {
  if (run.spawnError) {
    const missing = (run.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
    throw new AegisError(
      missing ? 'invalid_input' : 'upstream_error',
      missing
        ? `CLI „${cfg.command}“ nicht gefunden. Bitte installieren und anmelden, oder eine andere Brain-Quelle wählen.`
        : `CLI „${cfg.command}“ konnte nicht gestartet werden.`,
    );
  }
  if (run.timedOut) {
    throw new AegisError('upstream_error', `CLI „${cfg.command}“ hat das Zeitlimit überschritten.`);
  }
  if (run.code !== 0) {
    throw new AegisError('upstream_error', `CLI „${cfg.command}“ endete mit Fehler (${run.code}).`);
  }
  return run.stdout.trim();
}

export class CliBridgeProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    promptCache: false,
    // Headless CLIs return text, not structured tool calls.
    toolChoice: false,
    structuredOutput: false,
  };
  private readonly cfg: CliBridgeConfig;
  private readonly spawnImpl: SpawnFn;

  constructor(cfg: CliBridgeConfig, spawnImpl: SpawnFn = spawn) {
    this.cfg = cfg;
    this.id = `cli:${cfg.command}`;
    this.spawnImpl = spawnImpl;
  }

  private buildArgv(systemPrompt: string, model: string): string[] {
    return [...CLI_SPECS[this.cfg.command].args(systemPrompt, model), ...(this.cfg.extraArgs ?? [])];
  }

  async createMessage(params: ProviderCallParams): Promise<ProviderMessage> {
    const { system, prompt } = flattenPrompt(params.systemBlocks, params.messages);
    const argv = this.buildArgv(system, params.model);
    const run = await runCli(this.cfg, argv, prompt, this.spawnImpl);
    const text = assertOk(this.cfg, run);
    const content: ProviderContentBlock[] = [textBlock(text || '')];
    return buildCanonicalMessage({
      model: `${this.id}/${params.model}`,
      content,
      // Text-only backend: a normal end-of-turn. The loop returns the answer.
      stopReason: 'end_turn',
      usage: canonicalUsage(0, 0),
    });
  }

  async streamMessage(params: ProviderCallParams): Promise<ProviderMessageStream> {
    // Headless CLIs don't reliably stream token-by-token here; buffer the full
    // reply then emit it as a single text delta so the caller's streaming
    // contract still holds.
    const message = await this.createMessage(params);
    const text = (message.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    let iterated = false;
    async function* iterate(): AsyncGenerator<ProviderStreamEvent> {
      if (text) yield textDeltaEvent(text);
    }
    return {
      [Symbol.asyncIterator]() {
        iterated = true;
        return iterate()[Symbol.asyncIterator]();
      },
      async finalMessage(): Promise<ProviderMessage> {
        if (!iterated) {
          // drain (no-op state; message is already assembled)
          for await (const _ of iterate()) void _;
        }
        return message;
      },
    };
  }

  async completeText(params: {
    model: ModelId;
    prompt: string;
    maxTokens: number;
  }): Promise<{ text: string; usage: ClaudeUsage }> {
    const run = await runCli(this.cfg, this.buildArgv('', params.model), params.prompt, this.spawnImpl);
    return { text: assertOk(this.cfg, run), usage: canonicalUsage(0, 0) };
  }

  async structured<T>(params: {
    model: ModelId;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxTokens: number;
  }): Promise<{ value: T; usage: ClaudeUsage }> {
    // Best-effort: instruct the CLI to emit only JSON, then parse.
    const prompt = `${params.prompt}\n\nAntworte ausschließlich mit gültigem JSON gemäß diesem Schema:\n${JSON.stringify(params.schema)}`;
    const run = await runCli(this.cfg, this.buildArgv(params.system, params.model), prompt, this.spawnImpl);
    const text = assertOk(this.cfg, run);
    // Tolerate code fences / prose around the JSON.
    const match = text.match(/\{[\s\S]*\}/);
    try {
      return { value: JSON.parse(match ? match[0] : text) as T, usage: canonicalUsage(0, 0) };
    } catch {
      throw new AegisError('upstream_error', `CLI „${this.cfg.command}“ lieferte kein gültiges JSON.`);
    }
  }
}

/** Parse AEGIS_CLI_COMMAND / AEGIS_CLI_ARGS into a config, or null if unset/invalid. */
export function cliBridgeConfigFromEnv(env: Record<string, string | undefined> = process.env): CliBridgeConfig | null {
  const raw = env.AEGIS_CLI_COMMAND?.trim().toLowerCase();
  if (!raw) return null;
  if (raw !== 'claude' && raw !== 'codex' && raw !== 'gemini') return null;
  const extra = env.AEGIS_CLI_ARGS?.trim();
  return {
    command: raw,
    extraArgs: extra ? extra.split(/\s+/) : undefined,
    timeoutMs: env.AEGIS_CLI_TIMEOUT_MS ? Number(env.AEGIS_CLI_TIMEOUT_MS) : undefined,
  };
}
