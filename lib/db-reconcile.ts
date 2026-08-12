import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  canonicalSchemaHash,
  readSchemaFingerprint,
  schemaHashOf,
  CURRENT_SCHEMA_HASH,
  INIT_SCHEMA_HASH,
  PREPROVIDER_SCHEMA_HASH,
} from './db-fingerprint';

/**
 * Narrowly-scoped, transactional reconciliation of an EXACT `legacy_preprovider`
 * database to the current schema.
 *
 * The reconcile SQL is an IMMUTABLE, versioned asset with a recorded SHA-256 — it
 * is verified before use, so a modified asset fails closed. Reconciliation runs
 * only when the database matches the exact pre-provider schema fingerprint, is
 * applied inside a single transaction, and is followed by a check that the result
 * is EXACTLY the current schema fingerprint before the caller marks the preserved
 * init migration applied. Any mismatch throws — no partial or approximate upgrade.
 */

// Recorded, verified SHA-256 of the immutable reconcile asset (drift-checked in tests).
export const RECONCILE_SHA256 = '93317048bfaa7accc25bd3d70c25e66c20151692c8a9747da568ad1f2c729b1d';
// Re-exported so callers can depend on this module for the reconcile contract.
export { CURRENT_SCHEMA_HASH, PREPROVIDER_SCHEMA_HASH };

export function reconcileAssetPath(): string {
  return join(__dirname, '..', 'prisma', 'reconcile', 'preprovider-to-current.sql');
}

/** Read the reconcile SQL and verify its recorded SHA-256. Throws if tampered. */
export function readReconcileSql(): string {
  const sql = readFileSync(reconcileAssetPath(), 'utf8');
  const got = createHash('sha256').update(sql).digest('hex');
  if (got !== RECONCILE_SHA256) {
    throw new Error(`reconcile asset checksum mismatch: got ${got}, expected ${RECONCILE_SHA256} — refusing to run.`);
  }
  return sql;
}

export class FingerprintMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintMismatchError';
  }
}

/**
 * Upgrade an exact `legacy_preprovider` database to the INIT schema, in one
 * transaction. Preconditions and postconditions are hard fingerprint checks:
 *   pre:  schema hash == PREPROVIDER_SCHEMA_HASH
 *   post: schema hash == INIT_SCHEMA_HASH
 * The immutable asset lands the database at the `init` schema; the runner then
 * forward-applies the remaining migration(s) (`aegis_job_provider`) with
 * `migrate deploy`. Never runs against a database that is not exactly the
 * recognized legacy shape.
 */
export function reconcilePreprovider(dbPath: string): void {
  const before = schemaHashOf(dbPath);
  if (before !== PREPROVIDER_SCHEMA_HASH) {
    throw new FingerprintMismatchError(
      `refusing to reconcile: schema ${before} is not the exact legacy_preprovider fingerprint ${PREPROVIDER_SCHEMA_HASH}`,
    );
  }
  const sql = readReconcileSql();

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    // Single transaction. The asset uses `PRAGMA defer_foreign_keys=ON` (honored
    // inside a transaction) so the table rebuild's FK checks defer to COMMIT.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const after = canonicalSchemaHash(readSchemaFingerprint(db));
    if (after !== INIT_SCHEMA_HASH) {
      throw new FingerprintMismatchError(
        `reconcile produced schema ${after}, expected init schema ${INIT_SCHEMA_HASH}`,
      );
    }
  } finally {
    db.close();
  }
}
