import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, LockHeldError, type Liveness } from '@/lib/db-lock';

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-lock-'));
  lockPath = join(dir, 'db.migrate.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ALIVE: Liveness = () => 'alive';
const DEAD: Liveness = () => 'dead';
const UNKNOWN: Liveness = () => 'unknown';

const meta = { pid: 4242, dbPath: '/x/db', version: '0.1.0', kind: 'migration' as const };

describe('acquireLock — atomic + conservative stale handling', () => {
  it('acquires when free and writes metadata', () => {
    const h = acquireLock(lockPath, meta);
    expect(existsSync(lockPath)).toBe(true);
    expect(h.meta.pid).toBe(4242);
  });

  it('refuses when a LIVE owner holds it (fail closed, never break)', () => {
    acquireLock(lockPath, meta);
    expect(() => acquireLock(lockPath, { ...meta, pid: 9999 }, ALIVE)).toThrow(LockHeldError);
    expect(existsSync(lockPath)).toBe(true); // not broken
  });

  it('reclaims only a GENUINELY stale lock (owner provably dead)', () => {
    writeFileSync(lockPath, JSON.stringify({ ...meta, pid: 12345, createdAt: '2020-01-01' }));
    const h = acquireLock(lockPath, { ...meta, pid: 7 }, DEAD);
    expect(h.meta.pid).toBe(7);
  });

  it('fails closed when ownership cannot be determined', () => {
    writeFileSync(lockPath, JSON.stringify({ ...meta, pid: 12345, createdAt: '2020-01-01' }));
    expect(() => acquireLock(lockPath, meta, UNKNOWN)).toThrow(LockHeldError);
  });

  it('fails closed on an unreadable lock file (never break it)', () => {
    writeFileSync(lockPath, 'not json');
    expect(() => acquireLock(lockPath, meta)).toThrow(LockHeldError);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('release removes only a lock we still own', () => {
    const h = acquireLock(lockPath, meta);
    // Someone else reclaimed it (different metadata) — we must NOT delete theirs.
    writeFileSync(lockPath, JSON.stringify({ ...meta, pid: 5, createdAt: 'later' }));
    releaseLock(h);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('release removes our own lock', () => {
    const h = acquireLock(lockPath, meta);
    releaseLock(h);
    expect(existsSync(lockPath)).toBe(false);
  });
});
