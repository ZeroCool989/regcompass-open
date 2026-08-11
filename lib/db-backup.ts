import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalSchemaHash, readSchemaFingerprint } from './db-fingerprint';

/**
 * WAL-consistent SQLite backup + safe restore for the migration runner.
 *
 * Backup uses better-sqlite3's online backup API (`db.backup(dest)`) — it copies
 * a transactionally-consistent snapshot INCLUDING any WAL contents, and takes the
 * destination as a JS string so no filename is ever interpolated into SQL.
 * Restore neutralizes stale `-wal`/`-shm` sidecars so they can never be replayed
 * against the restored file, then atomically swaps the snapshot in.
 */

function assertIntegrity(db: Database.Database, label: string): void {
  const ic = db.pragma('integrity_check', { simple: true });
  if (ic !== 'ok') throw new Error(`${label} integrity_check failed: ${String(ic)}`);
  const fk = db.pragma('foreign_key_check') as unknown[];
  if (Array.isArray(fk) && fk.length > 0) {
    throw new Error(`${label} foreign_key_check found ${fk.length} violation(s)`);
  }
}

/** integrity_check + foreign_key_check on the database at `dbPath`. Throws on failure. */
export function verifyIntegrity(dbPath: string, label = 'database'): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(db, label);
  } finally {
    db.close();
  }
}

/** Application-owned backup directory (0700), created on demand. */
export function backupDir(dbPath: string): string {
  const dir = join(dirname(dbPath) || '.', 'backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on platforms without POSIX modes */
  }
  return dir;
}

function uniqueBackupPath(dbPath: string): string {
  const dir = backupDir(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  const name = `${basename(dbPath)}.${stamp}.${rand}.bak`;
  const path = join(dir, name);
  if (existsSync(path)) throw new Error(`backup path already exists (refusing to overwrite): ${path}`);
  return path;
}

/**
 * Snapshot `dbPath` into the backups dir. Verifies source AND backup with
 * integrity + foreign-key checks; sets 0600 perms; never overwrites. Returns the
 * backup path. Call IMMEDIATELY before the first mutation — not on every startup.
 */
export async function backupDatabase(dbPath: string): Promise<string> {
  const dest = uniqueBackupPath(dbPath);
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(src, 'source');
    await src.backup(dest);
  } finally {
    src.close();
  }
  const bak = new Database(dest, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(bak, 'backup');
  } finally {
    bak.close();
  }
  try {
    chmodSync(dest, 0o600);
  } catch {
    /* best-effort */
  }
  return dest;
}

function removeSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}

/**
 * Restore `dbPath` from `backupPath`. Caller MUST have closed all handles to
 * `dbPath` first. Neutralizes stale `-wal`/`-shm` sidecars (so nothing is
 * replayed), atomically swaps the snapshot in, then verifies integrity and —
 * when given — the expected schema hash. Throws if the restored DB fails checks.
 */
export function restoreDatabase(dbPath: string, backupPath: string, expectedSchemaHash?: string): void {
  removeSidecars(dbPath);
  const tmp = `${dbPath}.restore.${randomBytes(4).toString('hex')}`;
  copyFileSync(backupPath, tmp);
  rmSync(dbPath, { force: true });
  removeSidecars(dbPath);
  renameSync(tmp, dbPath); // atomic on the same filesystem
  removeSidecars(dbPath); // the restored snapshot is self-contained; no stale WAL

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(db, 'restored');
    if (expectedSchemaHash) {
      const got = canonicalSchemaHash(readSchemaFingerprint(db));
      if (got !== expectedSchemaHash) {
        throw new Error(`restored schema hash ${got} != expected ${expectedSchemaHash}`);
      }
    }
  } finally {
    db.close();
  }
}
