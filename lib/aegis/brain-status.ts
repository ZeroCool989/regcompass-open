/**
 * Reports how AEGIS is currently powered — the "brain" — for the account
 * settings UI, with a first-class view of the subscription-via-CLI path.
 *
 * RegCompass Open is local-first: each person runs it on their own machine, so
 * the legitimate way to use a Claude/ChatGPT/Gemini *subscription* (rather than
 * a pay-as-you-go API key) is the CLI bridge — AEGIS shells out to a CLI the
 * user is already signed into (`claude`, `codex`, `gemini`). That is the user
 * driving their own tool locally, which is allowed; routing a subscription
 * token through a hosted third-party app is not (see docs/USE_YOUR_SUBSCRIPTION.md
 * and docs/aegis/SIGN_IN_WITH_CLAUDE.md).
 *
 * Selection is env-driven and global (AEGIS_BRAIN / AEGIS_CLI_COMMAND), matching
 * lib/aegis/providers/catalog.ts. This module only *reads* that config — it never
 * writes .env — and the PATH lookup is filesystem-only (no process is spawned).
 */

import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { cliBridgeConfigFromEnv } from './providers/cli-bridge';

export type BrainKind = 'anthropic' | 'cli' | 'openai' | 'gemini' | 'ollama' | 'custom';

export interface CliSubscriptionStatus {
  /** The CLI configured to power AEGIS (claude | codex | gemini), or null. */
  command: string | null;
  /** True when AEGIS_BRAIN=cli AND AEGIS_CLI_COMMAND is a valid CLI name. */
  active: boolean;
  /** Whether that CLI is actually found on PATH (best-effort, fs-only). */
  onPath: boolean;
}

export interface BrainStatus {
  brain: BrainKind;
  cli: CliSubscriptionStatus;
}

/** Normalise AEGIS_BRAIN to a known brain kind (default: anthropic). */
export function brainKind(env: Record<string, string | undefined> = process.env): BrainKind {
  const raw = env.AEGIS_BRAIN?.trim().toLowerCase();
  if (!raw || raw === 'anthropic') return 'anthropic';
  if (raw === 'cli') return 'cli';
  if (raw === 'openai') return 'openai';
  if (raw === 'gemini') return 'gemini';
  if (raw === 'ollama') return 'ollama';
  return 'custom';
}

/**
 * Is `command` an executable on the current PATH? Pure filesystem check — never
 * spawns the CLI — so it is cheap and safe to call on a settings page load.
 */
export function commandExistsOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Reject anything that isn't a bare command name — never touch the filesystem
  // with caller-influenced path separators.
  if (!command || /[\\/]/.test(command)) return false;
  const pathVar = env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, command + ext);
      try {
        if (existsSync(full) && statSync(full).isFile()) return true;
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return false;
}

export function getBrainStatus(
  env: Record<string, string | undefined> = process.env,
): BrainStatus {
  const brain = brainKind(env);
  const cfg = cliBridgeConfigFromEnv(env);
  const active = brain === 'cli' && cfg !== null;
  const command = cfg?.command ?? null;
  return {
    brain,
    cli: {
      command,
      active,
      onPath: command ? commandExistsOnPath(command, env) : false,
    },
  };
}
