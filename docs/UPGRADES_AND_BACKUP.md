# Upgrades, database migration & backups

RegCompass Open is a downloadable, local-first app. Your data — conversations,
AEGIS memory, usage history, and your **encrypted provider credentials** — lives
in one local SQLite file (`local.db` by default; wherever `DATABASE_URL` points).
This document explains how upgrades keep that data safe.

## Migrations run automatically, before the app starts

Every time you launch RegCompass (`regcompass-open`, `pnpm start`, or the
installers), a safe migration runner (`scripts/db-migrate.ts`) executes **before**
the web server binds a socket. If it cannot finish safely, **the server does not
start** and your database is left as-is.

It performs, in order: resolve the DB path (from `DATABASE_URL`) → take a
migration lock → refuse if another instance is active → classify the database →
fast no-op if already current → **fail closed** on an unknown state → integrity +
foreign-key checks → **back up immediately before the first change** → reconcile
migration history using supported Prisma operations → apply forward migrations →
verify (schema, history, integrity, data) → restore from backup on any failure.

Production no longer uses `prisma db push`. `db push` cannot version or verify an
upgrade of an existing database; the runner can. (`pnpm db:push` remains for the
**developer** workflow only.)

## Recognized database states

| State | Meaning | Action |
|---|---|---|
| **empty** | new/empty database | apply the full schema |
| **legacy_preprovider** | older `db push` DB, exact pre-provider schema, no migration history | back up → transactional reconcile to current → mark the init migration applied |
| **legacy_current** | `db push` DB already on the current schema, no history | back up → mark the init migration applied |
| **migration_managed** | init migration applied, current schema (incl. a manually-baselined DB) | fast **no-op**, no backup |
| **unknown** | schema/history matches no known fingerprint (partial, foreign, unfinished, or rolled-back) | **fail closed** — no changes |

Classification combines an exact **schema fingerprint** (tables, columns, SQLite
types, nullability, normalized defaults, unique indexes) **and** a
**migration-history fingerprint** (applied names, checksums, finished/rolled-back
state). Presence of a column is never enough — an inexact match fails closed.

The pre-provider→current upgrade uses an **immutable, versioned SQL asset**
(`prisma/reconcile/preprovider-to-current.sql`) with a recorded SHA-256 that is
verified before use, applied inside a single transaction, and confirmed to produce
the exact current schema before history is touched.

## Backups

- Created **only when the database will actually change** (never on an
  already-current startup).
- Written to an app-owned `backups/` directory next to your database, with
  restrictive (0600) permissions — they contain your data.
- Named with a collision-resistant timestamp; **existing backups are never
  overwritten or deleted**.
- Taken with SQLite's online backup API (WAL-consistent) and verified with
  integrity + foreign-key checks. The backup path is printed at startup.

## Restore

If a migration or its verification fails, the runner restores your database from
the backup it just verified: it closes all handles, **neutralizes stale `-wal` /
`-shm` sidecar files** so nothing can be replayed, atomically swaps the snapshot
back in, and re-verifies it. If automatic restore cannot be proven safe, your
backup is left untouched and the exact restore path is printed.

To restore manually: stop RegCompass, then replace your database file with a
backup from `backups/` (also delete any `local.db-wal` / `local.db-shm` next to
it), and restart.

## Locks & concurrent launches

A migration lock (exclusive-create, with PID/timestamp/db-path/version metadata)
ensures only one process migrates at a time. It is **never broken just because it
is old** — a lock is reclaimed only when its owner is provably dead; if that can't
be determined, the runner fails closed. A separate instance lock, held by the
running server, makes a second launcher refuse to migrate while the app is active.

## Your `.env` and encryption key are never touched

The migration and installers never overwrite or regenerate `.env`,
`SESSION_SECRET`, `AEGIS_BYOK_ENCRYPTION_KEY`, provider API keys, or Codex
authentication state. **Keep your `.env` (and its `AEGIS_BYOK_ENCRYPTION_KEY`)** —
your stored provider credentials are encrypted with that key and cannot be
decrypted without it. Migrations preserve encrypted credentials unchanged.

## When migration is intentionally refused

If your database is in an **unknown** state, the runner stops without changing
anything and prints why. This is deliberate — it will not guess, reset, or delete
data. Options: restore a known-good backup, or open an issue with the printed
state summary (which contains no secrets or row data). RegCompass never runs
`prisma migrate reset` or `--accept-data-loss`.

## LAN access (reminder)

RegCompass binds to `127.0.0.1` (loopback) by default and is not reachable from
your network. Exposing it (`REGCOMPASS_HOST=0.0.0.0`) is **refused** unless you
run in authenticated multi-user mode (`AUTH_MODE=multi`) — the default local mode
has an implicit admin and no login, so it must never be network-reachable.
