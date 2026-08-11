import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * Database state classification for the safe migration runner.
 *
 * A downloadable install may carry a database in several states, and the schema
 * ALONE cannot distinguish them (a `db push` database and a migration-managed
 * one can have identical schemas). So classification combines TWO fingerprints:
 *   - the schema fingerprint (tables, columns, SQLite types, nullability,
 *     defaults, unique indexes — in particular the provider-aware columns), and
 *   - the migration-history fingerprint (`_prisma_migrations`: applied names,
 *     checksums, completion state, rollback state).
 *
 * Anything that does not match a KNOWN state classifies as `unknown` so the
 * runner can fail closed rather than guess. This module only READS the database
 * (opened readonly) and never mutates it.
 */

// The four provider-aware schema changes this project's migration introduces.
// Their presence/nullability is the discriminator between the pre-provider
// baseline schema and the current schema.
const PROVIDER_AWARE = {
  userColumn: 'aegisProvider',
  usageColumns: ['provider', 'priceStatus'] as const,
  nullableCostColumn: 'costCents',
};

/**
 * The one migration the project ships. Empirically-proven forward-only strategy:
 * the init migration is PRESERVED unchanged (no restructure). Its `.sql` describes
 * the current schema; every managed database has exactly this applied. A
 * manually-baselined database (the dev `local.db`) is INDISTINGUISHABLE on disk
 * from a normally-deployed one — identical `_prisma_migrations` rows and sha256
 * checksum — so both classify as `migration_managed`.
 */
export const INIT_MIGRATION = '20260810000000_init_provider_aware_cost';
/** Migration names the runner recognizes as legitimate history. */
export const KNOWN_MIGRATIONS: ReadonlySet<string> = new Set([INIT_MIGRATION]);

/**
 * Exact canonical schema-hash fingerprints (see {@link canonicalSchemaHash}).
 * Classification requires an EXACT match — presence of provider columns alone is
 * insufficient — so a partially-migrated or foreign schema fails closed as
 * `unknown`. A test recomputes these from reference fixtures and fails on drift.
 */
export const PREPROVIDER_SCHEMA_HASH = 'bf075953c0828392de7062c186e8aebe54fbeff4bf40dcdddbf4d9ece7c35a8a';
export const CURRENT_SCHEMA_HASH = 'feab30bd527c5fad585cb378e6055e3ca17a84de5cc1ac4a77a5e36ba88ea289';

export type ColumnInfo = { name: string; type: string; notnull: boolean; dflt: string | null; pk: boolean };
export type SchemaFingerprint = {
  tables: string[];
  columns: Record<string, ColumnInfo[]>;
  uniqueIndexes: Record<string, string[][]>;
};

export type MigrationRow = {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
  appliedSteps: number;
};
export type HistoryFingerprint = { hasTable: boolean; rows: MigrationRow[] };

export type DbState =
  /** No database / no application tables. */
  | 'empty'
  /** db push, no _prisma_migrations, schema WITHOUT provider-aware columns. */
  | 'legacy_preprovider'
  /** db push, no _prisma_migrations, schema already HAS provider-aware columns. */
  | 'legacy_current'
  /**
   * `_prisma_migrations` shows the init migration applied (finished, not rolled
   * back) and the schema is current. This SUBSUMES the spec's "manually
   * baselined" state: a db that was `db push`ed + `migrate resolve --applied`
   * (the dev local.db) is byte-identical on disk — same rows, same sha256
   * checksum — to one created by `migrate deploy`, so they cannot and need not
   * be distinguished. Runner action: no-op.
   */
  | 'migration_managed'
  /** History/schema do not match any known state → fail closed. */
  | 'unknown';

export type Classification = {
  state: DbState;
  providerAware: boolean;
  history: HistoryFingerprint;
  /** Human-readable reason, for the runner's diagnostics (no secrets). */
  detail: string;
};

/** Strip a Prisma `file:` URL down to the on-disk path. Honors DATABASE_URL. */
export function resolveSqlitePath(url: string | undefined = process.env.DATABASE_URL): string {
  const u = (url ?? 'file:./local.db').trim();
  return u.replace(/^file:/i, '');
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function userTables(db: Database.Database): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

export function readSchemaFingerprint(db: Database.Database): SchemaFingerprint {
  const tables = userTables(db);
  const columns: Record<string, ColumnInfo[]> = {};
  const uniqueIndexes: Record<string, string[][]> = {};
  for (const t of tables) {
    columns[t] = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>).map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, dflt: c.dflt_value, pk: !!c.pk }));

    const idx = db.prepare(`PRAGMA index_list("${t}")`).all() as Array<{ name: string; unique: number }>;
    uniqueIndexes[t] = idx
      .filter((i) => i.unique)
      .map((i) =>
        (db.prepare(`PRAGMA index_info("${i.name}")`).all() as Array<{ name: string }>).map((c) => c.name),
      );
  }
  return { tables, columns, uniqueIndexes };
}

export function readHistoryFingerprint(db: Database.Database): HistoryFingerprint {
  if (!tableExists(db, '_prisma_migrations')) return { hasTable: false, rows: [] };
  const rows = (db
    .prepare(
      'SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count FROM "_prisma_migrations" ORDER BY started_at',
    )
    .all() as Array<{
    migration_name: string;
    checksum: string;
    finished_at: string | null;
    rolled_back_at: string | null;
    applied_steps_count: number;
  }>).map((r) => ({
    name: r.migration_name,
    checksum: r.checksum,
    finished: r.finished_at != null,
    rolledBack: r.rolled_back_at != null,
    appliedSteps: r.applied_steps_count,
  }));
  return { hasTable: true, rows };
}

/** Normalize a SQLite default so semantically-equal spellings compare equal. */
function normalizeDefault(dflt: string | null): string | null {
  if (dflt == null) return null;
  let s = dflt.trim();
  // Strip one layer of matching quotes/parens Prisma/SQLite may add.
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('(') && s.endsWith(')'))) {
    s = s.slice(1, -1).trim();
  }
  return s.toUpperCase();
}

/**
 * A canonical, order-independent hash of the schema (tables, columns, SQLite
 * types, nullability, normalized defaults, unique indexes). Two databases with
 * the same logical schema hash to the same value regardless of column/table/
 * index declaration order or semantically-equal default spellings — so the
 * runner can require an EXACT fingerprint before a reconcile or a resolve.
 */
export function canonicalSchemaHash(fp: SchemaFingerprint): string {
  const canon = [...fp.tables].sort().map((t) => ({
    t,
    cols: [...fp.columns[t]]
      .map((c) => ({ n: c.name, ty: c.type.toUpperCase(), nn: c.notnull, d: normalizeDefault(c.dflt), pk: c.pk }))
      .sort((a, b) => a.n.localeCompare(b.n)),
    uniq: [...fp.uniqueIndexes[t]].map((cols) => [...cols].sort()).sort((a, b) => a.join().localeCompare(b.join())),
  }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/** Convenience: canonical schema hash of the database at `dbPath` (readonly). */
export function schemaHashOf(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return canonicalSchemaHash(readSchemaFingerprint(db));
  } finally {
    db.close();
  }
}

/** Does the schema carry all four provider-aware changes (incl. nullable cost)? */
export function hasProviderAwareSchema(fp: SchemaFingerprint): boolean {
  const user = fp.columns['User'];
  const usage = fp.columns['AegisUsageLog'];
  if (!user || !usage) return false;
  if (!user.some((c) => c.name === PROVIDER_AWARE.userColumn)) return false;
  for (const col of PROVIDER_AWARE.usageColumns) {
    if (!usage.some((c) => c.name === col)) return false;
  }
  const cost = usage.find((c) => c.name === PROVIDER_AWARE.nullableCostColumn);
  // costCents must exist AND be nullable (the incremental made it nullable).
  return !!cost && cost.notnull === false;
}

/** Migration names that were applied (finished, not rolled back). */
function appliedNames(history: HistoryFingerprint): Set<string> {
  return new Set(history.rows.filter((r) => r.finished && !r.rolledBack).map((r) => r.name));
}

/**
 * Classify the database at `dbPath` (defaults to the resolved DATABASE_URL path).
 * Combines schema + history fingerprints. Opens readonly; never mutates.
 */
export function classifyDatabase(dbPath: string = resolveSqlitePath()): Classification {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return { state: 'empty', providerAware: false, history: { hasTable: false, rows: [] }, detail: 'no database file' };
  }
  try {
    const schema = readSchemaFingerprint(db);
    const history = readHistoryFingerprint(db);
    const providerAware = hasProviderAwareSchema(schema);

    if (schema.tables.length === 0) {
      return { state: 'empty', providerAware, history, detail: 'no tables (fresh database)' };
    }
    if (!schema.tables.includes('User')) {
      // Tables present but not our schema → fail closed, never migrate a foreign DB.
      return { state: 'unknown', providerAware, history, detail: 'tables present but no User table — not a RegCompass database' };
    }

    // Classification keys on the EXACT canonical schema hash (not merely provider
    // columns), so a partial or foreign schema fails closed.
    const hash = canonicalSchemaHash(schema);
    const isCurrent = hash === CURRENT_SCHEMA_HASH;
    const isPreprovider = hash === PREPROVIDER_SCHEMA_HASH;
    const applied = appliedNames(history);
    const anyRolledBackOrUnfinished = history.rows.some((r) => r.rolledBack || !r.finished);

    if (!history.hasTable) {
      // No Prisma history → a db push database. Require an exact known schema.
      if (isCurrent) return { state: 'legacy_current', providerAware, history, detail: 'db push, exact current schema, no history' };
      if (isPreprovider) return { state: 'legacy_preprovider', providerAware, history, detail: 'db push, exact pre-provider schema, no history' };
      return { state: 'unknown', providerAware, history, detail: `db push, schema matches neither known fingerprint (${hash.slice(0, 12)}…)` };
    }

    // Has _prisma_migrations. Under the preserve-init strategy, a managed (or
    // manually-baselined) database has exactly the init migration applied AND the
    // exact current schema.
    if (anyRolledBackOrUnfinished) {
      return { state: 'unknown', providerAware, history, detail: 'history has an unfinished or rolled-back migration' };
    }
    const unrecognized = [...applied].filter((n) => !KNOWN_MIGRATIONS.has(n));
    if (unrecognized.length > 0) {
      return { state: 'unknown', providerAware, history, detail: `unrecognized migration(s): [${unrecognized.join(', ')}]` };
    }
    if (applied.has(INIT_MIGRATION) && isCurrent) {
      return { state: 'migration_managed', providerAware, history, detail: 'init migration applied; schema current' };
    }
    return {
      state: 'unknown',
      providerAware,
      history,
      detail: isCurrent ? 'current schema but init not marked applied' : `history present but schema not current (${hash.slice(0, 12)}…)`,
    };
  } finally {
    db.close();
  }
}
