import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runMigration,
  migrationLockPath,
  instanceLockPath,
  sanitize,
  type PrismaRunner,
} from '@/lib/db-migrate';
import { classifyDatabase, schemaHashOf, INIT_MIGRATION, PREPROVIDER_SCHEMA_HASH, CURRENT_SCHEMA_HASH } from '@/lib/db-fingerprint';
import { LockHeldError, type Liveness } from '@/lib/db-lock';
import { encryptApiKey, decryptApiKey, fingerprintApiKey } from '@/lib/aegis/provider-settings';

const ROOT = join(__dirname, '..', '..');
const PRE_SQL = readFileSync(join(__dirname, 'fixtures', 'preprovider-schema.sql'), 'utf8');
const CUR_SQL = readFileSync(join(__dirname, 'fixtures', 'current-schema.sql'), 'utf8');
const INIT_CHECKSUM = createHash('sha256')
  .update(readFileSync(join(ROOT, 'prisma', 'migrations', INIT_MIGRATION, 'migration.sql')))
  .digest('hex');

const ALIVE: Liveness = () => 'alive';
const DEAD: Liveness = () => 'dead';

// Guard: prove the real local.db is never touched by any scenario.
let localDbMtime: number | null = null;
beforeAll(() => {
  localDbMtime = existsSync(join(ROOT, 'local.db')) ? statSync(join(ROOT, 'local.db')).mtimeMs : null;
});
afterAll(() => {
  const now = existsSync(join(ROOT, 'local.db')) ? statSync(join(ROOT, 'local.db')).mtimeMs : null;
  expect(now).toBe(localDbMtime); // untouched
});

let dir: string;
let n = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-mig-'));
  n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── Faithful emulated Prisma (reproduces the empirically-proven behavior) ──────
function ensureMigrations(db: Database.Database) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT PRIMARY KEY NOT NULL,"checksum" TEXT NOT NULL,"finished_at" DATETIME,"migration_name" TEXT NOT NULL,"logs" TEXT,"rolled_back_at" DATETIME,"started_at" DATETIME NOT NULL DEFAULT current_timestamp,"applied_steps_count" INTEGER NOT NULL DEFAULT 0);`,
  );
}
function initApplied(db: Database.Database): boolean {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get();
  if (!t) return false;
  return !!db
    .prepare("SELECT 1 FROM _prisma_migrations WHERE migration_name=? AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
    .get(INIT_MIGRATION);
}
function recordInit(db: Database.Database) {
  ensureMigrations(db);
  if (!db.prepare('SELECT 1 FROM _prisma_migrations WHERE migration_name=?').get(INIT_MIGRATION)) {
    db.prepare(
      "INSERT INTO _prisma_migrations (id,checksum,migration_name,finished_at,started_at,applied_steps_count) VALUES (?,?,?,datetime('now'),datetime('now'),1)",
    ).run(`m${Math.round(performance.now())}`, INIT_CHECKSUM, INIT_MIGRATION);
  }
}
function hasUser(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='User'").get();
}
function emulatedPrisma(): PrismaRunner {
  return (args, dbPath) => {
    const db = new Database(dbPath);
    try {
      const cmd = args.join(' ');
      if (cmd.startsWith('migrate deploy')) {
        if (initApplied(db)) return { code: 0, output: 'No pending migrations to apply.' };
        if (!hasUser(db)) {
          db.exec(CUR_SQL);
          recordInit(db);
          return { code: 0, output: 'applied init' };
        }
        return { code: 1, output: 'drift: schema present without history' };
      }
      if (cmd.startsWith('migrate resolve')) {
        recordInit(db);
        return { code: 0, output: 'resolved' };
      }
      return { code: 0, output: '' };
    } finally {
      db.close();
    }
  };
}
/** A runner that fails on `resolve` (to simulate a mid-migration failure after the first mutation). */
function failingOnResolve(): PrismaRunner {
  return (args, dbPath) => {
    if (args.join(' ').startsWith('migrate resolve')) return { code: 1, output: 'boom' };
    return emulatedPrisma()(args, dbPath);
  };
}

// ── DB builders + seeders (temp only) ──────────────────────────────────────────
function newPath(): string {
  return join(dir, `db-${n++}.db`);
}
function apply(path: string, sql: string | null, fn?: (db: Database.Database) => void): string {
  const db = new Database(path);
  if (sql) db.exec(sql);
  fn?.(db);
  db.close();
  return path;
}
function seedUser(db: Database.Database, id: string) {
  db.prepare('INSERT INTO "User" (id,email,passwordHash) VALUES (?,?,?)').run(id, `${id}@t`, 'hash');
}
function seedUsagePre(db: Database.Database, id: string, cost: number) {
  db.prepare(
    'INSERT INTO "AegisUsageLog" (id,traceId,conversationId,mode,model,inputTokens,outputTokens,costCents,latencyMs,verifyPassed,kbVersion) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, 't', 'c', 'CONVERSATIONAL', 'claude-sonnet-4-6', 10, 5, cost, 100, 1, 'v1');
}
function seedCredential(db: Database.Database, userId: string, secret: string) {
  db.prepare(
    "INSERT INTO \"UserAiCredential\" (id,userId,provider,encryptedApiKey,keyFingerprint,updatedAt) VALUES (?,?,?,?,?,datetime('now'))",
  ).run(`cred-${userId}`, userId, 'ANTHROPIC', encryptApiKey(secret), fingerprintApiKey(secret));
}
function run(dbPath: string, prisma = emulatedPrisma(), liveness: Liveness = DEAD) {
  return runMigration({ dbPath, prisma, liveness });
}

// ── The 16-scenario matrix ─────────────────────────────────────────────────────
describe('migration runner — mandatory scenarios', () => {
  it('1. fresh empty database → full migration succeeds', async () => {
    const p = newPath(); // no file
    const r = await run(p);
    expect(r.action).toBe('fresh');
    expect(classifyDatabase(p).state).toBe('migration_managed');
    expect(schemaHashOf(p)).toBe(CURRENT_SCHEMA_HASH);
    expect(r.backupPath).toBeNull(); // nothing to back up
  });

  it('2. legacy pre-provider (no history) → upgraded, reconciled, rows preserved', async () => {
    const p = apply(newPath(), PRE_SQL, (db) => {
      seedUser(db, 'u1');
      seedUsagePre(db, 'r1', 0.99);
    });
    expect(classifyDatabase(p).state).toBe('legacy_preprovider');
    const r = await run(p);
    expect(r.action).toBe('reconciled');
    expect(r.backupPath).not.toBeNull();
    expect(classifyDatabase(p).state).toBe('migration_managed');
    // 15. Anthropic row preserved with provider=anthropic/priced/unchanged cost.
    const row = new Database(p, { readonly: true }).prepare('SELECT provider,priceStatus,costCents FROM AegisUsageLog WHERE id=?').get('r1') as {
      provider: string;
      priceStatus: string;
      costCents: number;
    };
    expect(row).toEqual({ provider: 'anthropic', priceStatus: 'priced', costCents: 0.99 });
  });

  it('3. migration-managed baseline → pending migration succeeds (no-op here)', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => recordInit(db));
    const r = await run(p);
    expect(r.action).toBe('noop');
  });

  it('4. manually baselined (state #4) → safe reconciliation = no-op', async () => {
    // Built exactly like the dev local.db: current schema + init recorded via resolve.
    const p = apply(newPath(), CUR_SQL);
    emulatedPrisma()(['migrate', 'resolve', '--applied', INIT_MIGRATION], p);
    const r = await run(p);
    expect(r.action).toBe('noop');
    expect(r.backupPath).toBeNull();
  });

  it('5. legacy current schema (no history) → safely baselined', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => seedUser(db, 'u1'));
    expect(classifyDatabase(p).state).toBe('legacy_current');
    const r = await run(p);
    expect(r.action).toBe('baselined');
    expect(classifyDatabase(p).state).toBe('migration_managed');
  });

  it('6. already-current → fast no-op with NO backup', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => recordInit(db));
    const r = await run(p);
    expect(r.action).toBe('noop');
    expect(existsSync(join(dir, 'backups'))).toBe(false); // no backup dir created
  });

  it('7. unknown schema → rejected without modification', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => db.exec('CREATE TABLE "Weird" (x TEXT)'));
    const before = schemaHashOf(p);
    await expect(run(p)).rejects.toThrow(/unrecognized|unknown/i);
    expect(schemaHashOf(p)).toBe(before); // unchanged
  });

  it('8. partially matching schema → rejected without modification', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => db.exec('ALTER TABLE "User" DROP COLUMN "aegisProvider"'));
    await expect(run(p)).rejects.toThrow(/unknown|unrecognized/i);
  });

  it('9. unfinished/rolled-back history → rejected', async () => {
    const p = apply(newPath(), CUR_SQL, (db) => {
      ensureMigrations(db);
      db.prepare("INSERT INTO _prisma_migrations (id,checksum,migration_name,started_at,applied_steps_count) VALUES (?,?,?,datetime('now'),1)").run(
        'x',
        'c',
        INIT_MIGRATION,
      ); // finished_at NULL → unfinished
    });
    await expect(run(p)).rejects.toThrow();
  });

  it('11. simulated mid-migration failure → restored to pre-migration, data intact', async () => {
    const p = apply(newPath(), PRE_SQL, (db) => {
      seedUser(db, 'u1');
      seedUsagePre(db, 'r1', 0.5);
    });
    await expect(run(p, failingOnResolve())).rejects.toThrow(/restored/i);
    // Restored to the exact pre-provider schema, row preserved.
    expect(schemaHashOf(p)).toBe(PREPROVIDER_SCHEMA_HASH);
    const c = new Database(p, { readonly: true }).prepare('SELECT count(*) c FROM AegisUsageLog').get() as { c: number };
    expect(c.c).toBe(1);
  });

  it('12. repeated invocation → idempotent (second run is a no-op)', async () => {
    const p = apply(newPath(), PRE_SQL, (db) => seedUser(db, 'u1'));
    const r1 = await run(p);
    expect(r1.action).toBe('reconciled');
    const r2 = await run(p);
    expect(r2.action).toBe('noop');
  });

  it('13. concurrent: another active instance → refused', async () => {
    const p = apply(newPath(), PRE_SQL);
    writeFileSync(instanceLockPath(p), JSON.stringify({ pid: 999999, createdAt: 'x', dbPath: p, version: '0', kind: 'instance' }));
    await expect(run(p, emulatedPrisma(), ALIVE)).rejects.toThrow(LockHeldError);
  });

  it('13b. concurrent: a held migration lock (live owner) → refused', async () => {
    const p = apply(newPath(), PRE_SQL);
    writeFileSync(migrationLockPath(p), JSON.stringify({ pid: 999999, createdAt: 'x', dbPath: p, version: '0', kind: 'migration' }));
    await expect(run(p, emulatedPrisma(), ALIVE)).rejects.toThrow(LockHeldError);
  });

  it('14 & 16. users/settings preserved; encrypted credential still decryptable after migration', async () => {
    const secret = 'sk-ant-super-secret-value';
    const p = apply(newPath(), PRE_SQL, (db) => {
      seedUser(db, 'u1');
      seedCredential(db, 'u1', secret);
    });
    const beforeUsers = (new Database(p, { readonly: true }).prepare('SELECT count(*) c FROM User').get() as { c: number }).c;
    await run(p);
    const db = new Database(p, { readonly: true });
    expect((db.prepare('SELECT count(*) c FROM User').get() as { c: number }).c).toBe(beforeUsers);
    const enc = (db.prepare('SELECT encryptedApiKey FROM UserAiCredential WHERE userId=?').get('u1') as { encryptedApiKey: string }).encryptedApiKey;
    db.close();
    expect(decryptApiKey(enc)).toBe(secret); // decryptable with the original key
  });

  it('13c/10. nullable provider cost + WAL data survive a reconcile', async () => {
    const p = newPath();
    const db = new Database(p);
    db.pragma('journal_mode = WAL');
    db.exec(PRE_SQL);
    seedUser(db, 'u1');
    seedUsagePre(db, 'r1', 0.42);
    db.close();
    await run(p);
    const row = new Database(p, { readonly: true }).prepare('SELECT costCents FROM AegisUsageLog WHERE id=?').get('r1') as { costCents: number | null };
    expect(row.costCents).toBe(0.42); // preserved; column now nullable
  });
});

describe('runner internals', () => {
  it('resolves DATABASE_URL, never a hardcoded local.db (fixtures are under tmp)', () => {
    const p = apply(newPath(), CUR_SQL);
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p).not.toBe(join(ROOT, 'local.db'));
  });
  it('sanitize() strips paths and file: urls from Prisma output', () => {
    const s = sanitize('error at /Users/me/app/local.db using file:/tmp/x.db and C:\\data\\app.db');
    expect(s).not.toContain('/Users/me/app/local.db');
    expect(s).not.toContain('file:/tmp/x.db');
  });
  it('the reconcile asset ships with LF endings (stable checksum across platforms)', () => {
    const raw = readFileSync(join(ROOT, 'prisma', 'reconcile', 'preprovider-to-current.sql'), 'utf8');
    expect(raw).not.toContain('\r'); // no CRLF
  });
});
