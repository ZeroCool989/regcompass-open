import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AEGIS_JOB_PROVIDER_MIGRATION,
  CURRENT_SCHEMA_HASH,
  INIT_MIGRATION,
  INIT_SCHEMA_HASH,
  PREPROVIDER_SCHEMA_HASH,
  canonicalSchemaHash,
  classifyDatabase,
  readSchemaFingerprint,
  resolveSqlitePath,
  schemaHashOf,
} from '@/lib/db-fingerprint';

const ROOT = join(__dirname, '..', '..');
const PRE_SQL = readFileSync(join(__dirname, 'fixtures', 'preprovider-schema.sql'), 'utf8');
// `current-schema.sql` is the schema after INIT only (no AegisJob.provider); in
// the two-migration sequence it is the INIT schema. The CURRENT schema is INIT +
// the aegis_job_provider migration's ALTER.
const INIT_SQL = readFileSync(join(__dirname, 'fixtures', 'current-schema.sql'), 'utf8');
const PROVIDER_MIG_SQL = readFileSync(
  join(ROOT, 'prisma', 'migrations', AEGIS_JOB_PROVIDER_MIGRATION, 'migration.sql'),
  'utf8',
);

let dir: string;
let counter = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-fp-'));
  counter = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(
  sql: string | null,
  opts: { extraSql?: string; history?: Array<{ name: string; finished?: boolean; rolledBack?: boolean }> } = {},
): string {
  const path = join(dir, `test-${counter++}.db`);
  const db = new Database(path);
  if (sql) db.exec(sql);
  if (opts.extraSql) db.exec(opts.extraSql);
  if (opts.history) {
    db.exec(
      `CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL,"checksum" TEXT NOT NULL,"finished_at" DATETIME,"migration_name" TEXT NOT NULL,"logs" TEXT,"rolled_back_at" DATETIME,"started_at" DATETIME NOT NULL DEFAULT current_timestamp,"applied_steps_count" INTEGER NOT NULL DEFAULT 0);`,
    );
    const ins = db.prepare(
      `INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,rolled_back_at,applied_steps_count) VALUES (?,?,?,?,?,1)`,
    );
    opts.history.forEach((h, i) =>
      ins.run(`i${i}`, `c${i}`, h.name, h.finished === false ? null : '2026-08-10', h.rolledBack ? '2026-08-10' : null),
    );
  }
  db.close();
  return path;
}
/** SQL string that produces the full CURRENT schema (INIT + provider ALTER). */
const CUR_SQL = `${INIT_SQL}\n${PROVIDER_MIG_SQL}`;

describe('recorded fingerprints match the reference fixtures (drift guard)', () => {
  it('the hardcoded PREPROVIDER/INIT/CURRENT hashes equal the fixtures', () => {
    expect(schemaHashOf(build(PRE_SQL))).toBe(PREPROVIDER_SCHEMA_HASH);
    expect(schemaHashOf(build(INIT_SQL))).toBe(INIT_SCHEMA_HASH);
    expect(schemaHashOf(build(CUR_SQL))).toBe(CURRENT_SCHEMA_HASH);
    // All three are distinct fingerprints.
    expect(new Set([PREPROVIDER_SCHEMA_HASH, INIT_SCHEMA_HASH, CURRENT_SCHEMA_HASH]).size).toBe(3);
  });
});

describe('canonicalSchemaHash — order/format independence', () => {
  it('is stable regardless of column declaration order', () => {
    const a = new Database(join(dir, 'a.db'));
    a.exec('CREATE TABLE t (b TEXT, a TEXT NOT NULL DEFAULT 1)');
    const b = new Database(join(dir, 'b.db'));
    b.exec("CREATE TABLE t (a TEXT NOT NULL DEFAULT '1', b TEXT)"); // reordered + quoted default
    const ha = canonicalSchemaHash(readSchemaFingerprint(a));
    const hb = canonicalSchemaHash(readSchemaFingerprint(b));
    a.close();
    b.close();
    expect(ha).toBe(hb);
  });
});

describe('resolveSqlitePath', () => {
  it('strips file: and honors DATABASE_URL', () => {
    expect(resolveSqlitePath('file:./local.db')).toBe('./local.db');
    expect(resolveSqlitePath('file:/abs/x.db')).toBe('/abs/x.db');
  });
});

describe('classifyDatabase — exact schema + history', () => {
  it('empty: no file', () => {
    expect(classifyDatabase(join(dir, 'nope.db')).state).toBe('empty');
  });

  it('empty: file with no tables at all (fresh)', () => {
    expect(classifyDatabase(build(null)).state).toBe('empty');
  });

  it('unknown: a foreign database (tables present, but no User table) fails closed', () => {
    const p = build(null, {});
    const db = new Database(p);
    db.exec('CREATE TABLE "SomeoneElse" (x TEXT)');
    db.close();
    expect(classifyDatabase(p).state).toBe('unknown');
  });

  it('legacy_preprovider: exact pre-provider schema, no history', () => {
    expect(classifyDatabase(build(PRE_SQL)).state).toBe('legacy_preprovider');
  });

  it('legacy_init: exact INIT schema (pre AegisJob.provider), no history', () => {
    expect(classifyDatabase(build(INIT_SQL)).state).toBe('legacy_init');
  });

  it('legacy_current: exact current schema, no history', () => {
    expect(classifyDatabase(build(CUR_SQL)).state).toBe('legacy_current');
  });

  it('migration_pending: INIT schema + init applied, provider migration not yet applied', () => {
    expect(classifyDatabase(build(INIT_SQL, { history: [{ name: INIT_MIGRATION }] })).state).toBe('migration_pending');
  });

  it('migration_managed: current schema + FULL sequence applied (covers manually-baselined)', () => {
    expect(
      classifyDatabase(
        build(CUR_SQL, { history: [{ name: INIT_MIGRATION }, { name: AEGIS_JOB_PROVIDER_MIGRATION }] }),
      ).state,
    ).toBe('migration_managed');
  });

  it('unknown: current schema but the provider migration is not recorded → drift, fails closed', () => {
    expect(classifyDatabase(build(CUR_SQL, { history: [{ name: INIT_MIGRATION }] })).state).toBe('unknown');
  });

  it('unknown: PARTIAL schema (current minus a column) fails closed', () => {
    const path = build(CUR_SQL);
    const db = new Database(path);
    db.exec('ALTER TABLE "User" DROP COLUMN "aegisProvider"'); // partial — neither known hash
    db.close();
    expect(classifyDatabase(path).state).toBe('unknown');
  });

  it('unknown: current schema but NO history (would be legacy_current) vs current+unrecognized name', () => {
    expect(classifyDatabase(build(CUR_SQL, { history: [{ name: '99999_foreign' }] })).state).toBe('unknown');
  });

  it('unknown: unfinished migration', () => {
    expect(classifyDatabase(build(CUR_SQL, { history: [{ name: INIT_MIGRATION, finished: false }] })).state).toBe('unknown');
  });

  it('unknown: rolled-back migration', () => {
    expect(classifyDatabase(build(CUR_SQL, { history: [{ name: INIT_MIGRATION, rolledBack: true }] })).state).toBe('unknown');
  });
});

// Guard: the tests must never resolve to the real local.db.
describe('fixture isolation', () => {
  it('temp db paths are never the repo local.db', () => {
    const p = build(CUR_SQL);
    expect(p).not.toContain(join(ROOT, 'local.db'));
    expect(p.startsWith(tmpdir())).toBe(true);
  });
});
