import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthTokens } from './core';
import { saveConnection, readSecrets, viewConnection } from './store';

/**
 * Codex OAuth bridge — reads a locally cached Codex auth token and imports it
 * into the RegCompass subscription store for the `openai` provider. This lets
 * a user run `npx openai-oauth login` (or `codex login`) once, and RegCompass
 * automatically picks up the subscription token.
 *
 * The Codex token lives at `~/.codex/auth.json` and carries an access_token
 * (and optionally a refresh_token + expires_at) usable as a Bearer credential
 * against the ChatGPT backend API — the same endpoint the OpenAI-compatible
 * provider already targets.
 *
 * This is an unofficial path that relies on the Codex CLI's own OAuth flow.
 * If OpenAI opens official third-party OAuth registration, the standard flow
 * in registry.ts takes precedence and this bridge becomes a no-op.
 */

type CodexAuthFile = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number | string;
  token_type?: string;
};

const CODEX_AUTH_PATHS = [
  join(homedir(), '.codex', 'auth.json'),
  join(homedir(), '.config', 'codex', 'auth.json'),
];

function findCodexAuth(): string | null {
  for (const p of CODEX_AUTH_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

function readCodexAuth(): CodexAuthFile | null {
  const path = findCodexAuth();
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile;
    if (raw && typeof raw.access_token === 'string' && raw.access_token.trim()) {
      return raw;
    }
  } catch {
    // Corrupt or unreadable — treat as absent.
  }
  return null;
}

/**
 * Check whether a Codex auth token exists locally.
 */
export function hasCodexAuth(): boolean {
  return readCodexAuth() !== null;
}

/**
 * Import the Codex auth token into the RegCompass store for the `openai`
 * provider. Returns true on success, false when no token is found.
 */
export function importCodexAuth(): boolean {
  const codex = readCodexAuth();
  if (!codex) return false;

  const expiresAt = codex.expires_at
    ? new Date(typeof codex.expires_at === 'number' ? codex.expires_at * 1000 : codex.expires_at)
    : null;

  const tokens: OAuthTokens = {
    accessToken: codex.access_token!,
    refreshToken: codex.refresh_token ?? null,
    tokenType: codex.token_type ?? 'Bearer',
    scope: null,
    expiresAt,
  };

  saveConnection('openai', tokens);
  return true;
}

/**
 * Sync check: if the user has a Codex auth but no RegCompass connection for
 * OpenAI, auto-import it. Called during provider view resolution so the UI
 * reflects the current state without manual action.
 */
export function syncCodexAuth(): void {
  const connection = viewConnection('openai');
  if (connection.connected) return; // already have a connection, don't overwrite
  if (hasCodexAuth()) {
    importCodexAuth();
  }
}
