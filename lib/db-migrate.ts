import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyDatabase,
  resolveSqlitePath,
  schemaHashOf,
  INIT_MIGRATION,
  MIGRATION_SEQUENCE,
  type DbState,
} from './db-fingerprint';
import { acquireLock, releaseLock, defaultLiveness, LockHeldError, type Liveness, type LockHandle } from './db-lock';
import { backupDatabase, restoreDatabase, verifyIntegrity } from './db-backup';
import { reconcilePreprovider, CURRENT_SCHEMA_HASH, PREPROVIDER_SCHEMA_HASH } from './db-reconcile';

/**
 * The safe downloadable-app migration runner (mandatory execution order):
 *  1. resolve+validate path  2. acquire migration lock  3. confirm no active
 *  instance  4. classify  5. current→fast no-op (no backup)  6. unknown→fail
 *  closed  7. source integrity+fk  8. backup immediately before the first
 *  mutation  9. reconcile via supported ops  10. forward migrate  11. verify
 *  12. restore on failure  13. release lock. The server starts only on success.
 *
 * Never falls back to a hardcoded local.db (uses the resolved DATABASE_URL);
 * never uses reset/--accept-data-loss; never rewrites _prisma_migrations directly.
 */

export type PrismaResult = { code: number; output: string };
export type PrismaRunner = (args: string[], dbPath: string) => PrismaResult;

/** Default: run the project's Prisma CLI against the given DB via DATABASE_URL. */
export const realPrisma: PrismaRunner = (args, dbPath) => {
  const r = spawnSync('pnpm', ['exec', 'prisma', ...args], {
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, output: sanitize(`${r.stdout ?? ''}${r.stderr ?? ''}`) };
};

/** Strip absolute paths / obvious secrets from Prisma output before surfacing it. */
export function sanitize(s: string): string {
  return s
    .replace(/file:[^\s"']+/g, 'file:<db>')
    .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']*\.db/g, '<path>')
    .trim();
}

export type MigrationAction = 'noop' | 'fresh' | 'baselined' | 'reconciled' | 'migrated';
export type MigrationResult = { action: MigrationAction; state: DbState; backupPath: string | null };

export function migrationLockPath(dbPath: string): string {
  return join(dbPath + '.migrate.lock');
}
export function instanceLockPath(dbPath: string): string {
  return join(dbPath + '.instance.lock');
}

class MigrationError extends Error {}

function prismaOrThrow(prisma: PrismaRunner, args: string[], dbPath: string): void {
  const r = prisma(args, dbPath);
  if (r.code !== 0) throw new MigrationError(`prisma ${args.join(' ')} failed: ${r.output}`);
}

export type RunOptions = {
  dbPath?: string;
  prisma?: PrismaRunner;
  liveness?: Liveness;
  appVersion?: string;
  /** Existing instance-lock owner to treat as self (set by scripts/start.ts). */
  selfPid?: number;
};

/**
 * Classify + migrate the database. Returns the action taken. Throws (leaving the
 * verified backup in place) if a state is unsafe or a step fails; on a failure
 * after the first mutation it restores from the backup first.
 */
export async function runMigration(opts: RunOptions = {}): Promise<MigrationResult> {
  const dbPath = opts.dbPath ?? resolveSqlitePath();
  if (!dbPath.trim()) throw new MigrationError('empty database path');
  const prisma = opts.prisma ?? realPrisma;
  const liveness = opts.liveness ?? defaultLiveness;

  // (3) No OTHER active instance may hold the DB while we migrate.
  assertNoForeignInstance(dbPath, liveness, opts.selfPid);

  // (2) Migration lock.
  const lock: LockHandle = acquireLock(
    migrationLockPath(dbPath),
    { pid: process.pid, dbPath, version: opts.appVersion ?? 'unknown', kind: 'migration' },
    liveness,
  );

  let backupPath: string | null = null;
  let preHash: string | null = null;
  try {
    // (4) classify.
    const cls = classifyDatabase(dbPath);

    // (5) already current → fast no-op, NO backup.
    if (cls.state === 'migration_managed') return { action: 'noop', state: cls.state, backupPath: null };

    // (6) unknown → fail closed, no mutation.
    if (cls.state === 'unknown') {
      throw new MigrationError(`refusing to migrate an unrecognized database state: ${cls.detail}`);
    }

    // Fresh empty DB → deploy the full schema (nothing to back up / restore).
    if (cls.state === 'empty') {
      prismaOrThrow(prisma, ['migrate', 'deploy'], dbPath);
      verifyCurrent(dbPath);
      return { action: 'fresh', state: cls.state, backupPath: null };
    }

    // Every remaining state mutates existing data/history → (7) integrity + (8)
    // backup first. Forward-only: reconcile (if needed) lands at the INIT schema,
    // baselining marks already-present migrations applied WITHOUT re-running their
    // SQL, and `migrate deploy` applies only the genuinely-pending migrations.
    verifyIntegrity(dbPath, 'source');
    preHash = schemaHashOf(dbPath);
    backupPath = await backupDatabase(dbPath);

    try {
      switch (cls.state) {
        case 'legacy_preprovider':
          // (9) transactional, fingerprint-gated reconcile → INIT schema, mark
          // init applied, then (10) forward-apply the pending provider migration.
          reconcilePreprovider(dbPath);
          prismaOrThrow(prisma, ['migrate', 'resolve', '--applied', INIT_MIGRATION], dbPath);
          prismaOrThrow(prisma, ['migrate', 'deploy'], dbPath);
          break;
        case 'legacy_init':
          // db push at the INIT schema: baseline init, then forward-apply the
          // provider migration (its ALTER adds the missing column + backfills).
          prismaOrThrow(prisma, ['migrate', 'resolve', '--applied', INIT_MIGRATION], dbPath);
          prismaOrThrow(prisma, ['migrate', 'deploy'], dbPath);
          break;
        case 'legacy_current':
          // db push already at the CURRENT schema (AegisJob.provider present):
          // baseline the WHOLE sequence — never re-run an ALTER for a column that
          // already exists (which would fail). No SQL is applied.
          for (const m of MIGRATION_SEQUENCE) {
            prismaOrThrow(prisma, ['migrate', 'resolve', '--applied', m], dbPath);
          }
          break;
        case 'migration_pending':
          // Managed DB missing only the newest migration → (10) forward-apply it.
          prismaOrThrow(prisma, ['migrate', 'deploy'], dbPath);
          break;
      }
      // (11) verify → must be migration_managed at the CURRENT schema.
      verifyCurrent(dbPath);
    } catch (err) {
      // (12) restore from the verified backup, sidecar-safe, back to pre-migration.
      restoreDatabase(dbPath, backupPath, preHash ?? undefined);
      throw new MigrationError(
        `migration failed and the database was restored from ${backupPath}. Cause: ${(err as Error).message}`,
      );
    }
    const action: MigrationAction =
      cls.state === 'legacy_preprovider'
        ? 'reconciled'
        : cls.state === 'migration_pending'
          ? 'migrated'
          : 'baselined';
    return { action, state: cls.state, backupPath };
  } finally {
    // (13) release lock.
    releaseLock(lock);
  }
}

function verifyCurrent(dbPath: string): void {
  verifyIntegrity(dbPath, 'post-migration');
  const cls = classifyDatabase(dbPath);
  if (cls.state !== 'migration_managed') {
    throw new MigrationError(`post-migration verification failed: state is ${cls.state} (${cls.detail})`);
  }
  const hash = schemaHashOf(dbPath);
  if (hash !== CURRENT_SCHEMA_HASH) {
    throw new MigrationError(`post-migration schema ${hash} != current ${CURRENT_SCHEMA_HASH}`);
  }
}

/** Fail closed if another (live, different-pid) instance holds the instance lock. */
function assertNoForeignInstance(dbPath: string, liveness: Liveness, selfPid?: number): void {
  const path = instanceLockPath(dbPath);
  if (!existsSync(path)) return;
  let meta: { pid?: number; createdAt?: string } = {};
  try {
    meta = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; createdAt?: string };
  } catch {
    throw new LockHeldError(null, `instance lock ${path} is unreadable — refusing to migrate.`);
  }
  if (typeof meta.pid !== 'number') return;
  if (meta.pid === (selfPid ?? process.pid)) return; // our own instance lock
  if (liveness(meta.pid) !== 'dead') {
    throw new LockHeldError(
      meta as never,
      `another RegCompass instance (pid ${meta.pid}) is active — refusing to migrate the database.`,
    );
  }
}

// Referenced by the pre-provider path's fingerprint gate (kept here for clarity).
export { PREPROVIDER_SCHEMA_HASH };
