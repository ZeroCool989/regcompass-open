import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, restoreDatabase, verifyIntegrity } from '@/lib/db-backup';
import { schemaHashOf } from '@/lib/db-fingerprint';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-bak-'));
  dbPath = join(dir, 'app.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeWalDb(path: string, rows: number): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  const tx = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) ins.run(`row-${i}`);
  });
  tx(rows);
  db.close(); // leaves data; -wal/-shm may exist depending on checkpoint
}

describe('backupDatabase — WAL-consistent', () => {
  it('captures all committed rows even in WAL mode', async () => {
    makeWalDb(dbPath, 500);
    const bak = await backupDatabase(dbPath);
    expect(existsSync(bak)).toBe(true);
    const db = new Database(bak, { readonly: true });
    expect((db.prepare('SELECT count(*) c FROM t').get() as { c: number }).c).toBe(500);
    db.close();
  });

  it('never overwrites — two backups are distinct files', async () => {
    makeWalDb(dbPath, 3);
    const a = await backupDatabase(dbPath);
    const b = await backupDatabase(dbPath);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it('verifyIntegrity passes on a healthy db', () => {
    makeWalDb(dbPath, 1);
    expect(() => verifyIntegrity(dbPath)).not.toThrow();
  });
});

describe('restoreDatabase — sidecar-safe', () => {
  it('restores committed data and neutralizes stale -wal/-shm', async () => {
    makeWalDb(dbPath, 10);
    const expectHash = schemaHashOf(dbPath);
    const bak = await backupDatabase(dbPath);

    // Mutate the live db AFTER backup, then plant stale sidecars.
    const db = new Database(dbPath);
    db.exec("INSERT INTO t (v) VALUES ('post-backup')");
    db.close();
    writeFileSync(dbPath + '-wal', 'stale-wal-bytes');
    writeFileSync(dbPath + '-shm', 'stale-shm-bytes');

    restoreDatabase(dbPath, bak, expectHash);

    // The stale garbage sidecars must not survive to be replayed: data == the
    // snapshot (10 rows, NOT 11) proves the planted stale -wal was neutralized,
    // not replayed. (A valid restored DB may create fresh, consistent sidecars.)
    const r = new Database(dbPath, { readonly: true });
    expect((r.prepare('SELECT count(*) c FROM t').get() as { c: number }).c).toBe(10);
    r.close();
    // Whatever sidecars exist now are the restored DB's own — never the planted garbage.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) {
        expect(readFileSync(dbPath + suffix, 'utf8')).not.toContain('stale-');
      }
    }
  });

  it('throws if the restored schema hash does not match the expected one', async () => {
    makeWalDb(dbPath, 2);
    const bak = await backupDatabase(dbPath);
    expect(() => restoreDatabase(dbPath, bak, 'deadbeef')).toThrow(/schema hash/);
  });
});
