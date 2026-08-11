import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertBindingAllowed, BindingRefusedError } from '../lib/deployment';
import { resolveSqlitePath } from '../lib/db-fingerprint';
import { acquireLock, releaseLock, LockHeldError, type LockHandle } from '../lib/db-lock';
import { instanceLockPath } from '../lib/db-migrate';
import { migrateOrExit } from './db-migrate';

/**
 * The single production start path for a downloadable RegCompass install. Both
 * `pnpm start` and `bin/regcompass-open` route through here so the order is
 * always: refuse an unsafe network bind → hold an app-instance lock (so a second
 * launcher can't migrate under a live server) → migrate + verify the database →
 * only then start Next.js. Any failure exits non-zero and never starts the server.
 */
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  let host: string;
  try {
    host = assertBindingAllowed();
  } catch (err) {
    if (err instanceof BindingRefusedError) {
      console.error('\n✗ ' + err.message + '\n');
      process.exit(1);
    }
    throw err;
  }

  const dbPath = resolveSqlitePath();

  // App-instance lock: held from before migration until this process exits, so a
  // second launcher refuses to migrate while this server is active.
  let instanceLock: LockHandle;
  try {
    instanceLock = acquireLock(instanceLockPath(dbPath), {
      pid: process.pid,
      dbPath,
      version: appVersion(),
      kind: 'instance',
    });
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error('\n✗ ' + err.message + '\n');
      process.exit(1);
    }
    throw err;
  }
  const cleanup = () => {
    try {
      releaseLock(instanceLock);
    } catch {
      /* best-effort */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  // Migrate + verify before the server binds a socket. Exits non-zero on failure.
  await migrateOrExit(process.pid);

  const port = process.env.PORT || '3000';
  const child = spawn('pnpm', ['exec', 'next', 'start', '-H', host, '-p', port], { stdio: 'inherit' });
  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error('✗ Failed to start Next.js:', err instanceof Error ? err.message : String(err));
    cleanup();
    process.exit(1);
  });
}

void main();
