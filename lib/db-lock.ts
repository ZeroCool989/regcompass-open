import { openSync, closeSync, writeSync, readFileSync, rmSync, existsSync } from 'node:fs';

/**
 * Cross-process migration lock.
 *
 * Acquired atomically via exclusive file creation (`open` with `wx`), so two
 * launchers cannot both enter migration. The lock file records who holds it.
 * Stale handling is CONSERVATIVE: a lock is never broken just because it is old.
 * We only reclaim it when we can prove the owning process is dead; if ownership
 * cannot be determined safely, we fail closed rather than risk two concurrent
 * migrations.
 */

export type LockMeta = {
  pid: number;
  createdAt: string;
  dbPath: string;
  version: string;
  kind: 'migration' | 'instance';
};

export class LockHeldError extends Error {
  constructor(public readonly meta: LockMeta | null, message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

/** Injectable liveness probe (default: POSIX signal-0). Returns 'alive'|'dead'|'unknown'. */
export type Liveness = (pid: number) => 'alive' | 'dead' | 'unknown';

export const defaultLiveness: Liveness = (pid) => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive'; // exists but not ours — treat as alive
    return 'unknown';
  }
};

function readMeta(path: string): LockMeta | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockMeta;
  } catch {
    return null;
  }
}

function tryCreate(path: string, meta: LockMeta): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx'); // atomic: fails if the file already exists
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(meta, null, 2));
  } finally {
    closeSync(fd);
  }
  return true;
}

export type LockHandle = { path: string; meta: LockMeta };

/**
 * Acquire `lockPath` atomically. If it already exists, reclaim it ONLY when the
 * owner is provably dead; otherwise throw {@link LockHeldError} (active or
 * indeterminate → fail closed). Never breaks a live lock.
 */
export function acquireLock(
  lockPath: string,
  meta: Omit<LockMeta, 'createdAt'>,
  liveness: Liveness = defaultLiveness,
): LockHandle {
  const full: LockMeta = { ...meta, createdAt: new Date().toISOString() };
  if (tryCreate(lockPath, full)) return { path: lockPath, meta: full };

  // Exists — inspect the owner.
  const existing = readMeta(lockPath);
  if (!existing || typeof existing.pid !== 'number') {
    throw new LockHeldError(existing, `Migration lock ${lockPath} exists but is unreadable — refusing to break it.`);
  }
  const state = existing.pid === process.pid ? 'alive' : liveness(existing.pid);
  if (state !== 'dead') {
    throw new LockHeldError(
      existing,
      `Another RegCompass process (pid ${existing.pid}, since ${existing.createdAt}) holds the migration lock. ` +
        `Not starting to avoid concurrent migration.`,
    );
  }
  // Owner is provably dead: reclaim atomically (remove the stale file, re-create).
  rmSync(lockPath, { force: true });
  if (tryCreate(lockPath, full)) return { path: lockPath, meta: full };
  // A race re-created it between rm and create — fail closed.
  throw new LockHeldError(readMeta(lockPath), `Migration lock ${lockPath} was re-acquired concurrently — refusing to proceed.`);
}

export function releaseLock(handle: LockHandle): void {
  // Only release a lock we still own (same pid + createdAt), so we never delete
  // a lock another process reclaimed.
  const cur = readMeta(handle.path);
  if (cur && cur.pid === handle.meta.pid && cur.createdAt === handle.meta.createdAt) {
    rmSync(handle.path, { force: true });
  }
}

export function lockExists(lockPath: string): boolean {
  return existsSync(lockPath);
}
