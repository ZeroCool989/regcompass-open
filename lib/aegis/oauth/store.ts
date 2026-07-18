import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { decryptApiKey, encryptApiKey } from '../provider-settings';
import type { OAuthProviderId } from './registry';
import type { OAuthTokens } from './core';

/**
 * Local, single-user credential store for connected subscriptions.
 *
 * Tokens live in ~/.regcompass-open/auth.json — never in the app database and
 * never leaving the machine. The directory is created 0700 and the file 0600
 * (re-applied on every write); access/refresh tokens are additionally encrypted
 * at rest with the app's AES-256-GCM key. Writes are atomic (temp file + rename)
 * so a crash mid-write cannot corrupt the store.
 */

type StoredConnection = {
  encryptedAccess: string;
  encryptedRefresh: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: string | null; // ISO
  connectedAt: string; // ISO
  lastError: string | null;
};

type StoreFile = {
  version: 1;
  connections: Partial<Record<OAuthProviderId, StoredConnection>>;
};

export function storeDir(): string {
  return process.env.REGCOMPASS_OPEN_DIR?.trim() || join(homedir(), '.regcompass-open');
}

function storePath(): string {
  return join(storeDir(), 'auth.json');
}

function readStore(): StoreFile {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, connections: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
    if (parsed && parsed.version === 1 && parsed.connections) return parsed;
  } catch {
    // A corrupt store is treated as empty rather than crashing the app; the
    // user simply reconnects. We never surface the raw contents.
  }
  return { version: 1, connections: {} };
}

function writeStore(data: StoreFile): void {
  const dir = storeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  const path = storePath();
  const tmp = join(dirname(path), `.auth.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

export type ConnectionView = {
  connected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  scope: string | null;
  lastError: string | null;
};

export function viewConnection(id: OAuthProviderId): ConnectionView {
  const row = readStore().connections[id];
  return {
    connected: !!row,
    connectedAt: row?.connectedAt ?? null,
    expiresAt: row?.expiresAt ?? null,
    scope: row?.scope ?? null,
    lastError: row?.lastError ?? null,
  };
}

export function saveConnection(id: OAuthProviderId, tokens: OAuthTokens): void {
  const store = readStore();
  const existing = store.connections[id];
  store.connections[id] = {
    encryptedAccess: encryptApiKey(tokens.accessToken),
    encryptedRefresh: tokens.refreshToken ? encryptApiKey(tokens.refreshToken) : (existing?.encryptedRefresh ?? null),
    tokenType: tokens.tokenType,
    scope: tokens.scope ?? existing?.scope ?? null,
    expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    lastError: null,
  };
  writeStore(store);
}

export function setConnectionError(id: OAuthProviderId, message: string): void {
  const store = readStore();
  const row = store.connections[id];
  if (!row) return;
  row.lastError = message;
  writeStore(store);
}

export function deleteConnection(id: OAuthProviderId): void {
  const store = readStore();
  if (store.connections[id]) {
    delete store.connections[id];
    writeStore(store);
  }
}

/** Decrypted secrets for internal use only — never returned to any HTTP layer. */
export type ConnectionSecrets = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  tokenType: string;
};

export function readSecrets(id: OAuthProviderId): ConnectionSecrets | null {
  const row = readStore().connections[id];
  if (!row) return null;
  try {
    return {
      accessToken: decryptApiKey(row.encryptedAccess),
      refreshToken: row.encryptedRefresh ? decryptApiKey(row.encryptedRefresh) : null,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
      scope: row.scope,
      tokenType: row.tokenType,
    };
  } catch {
    return null;
  }
}
