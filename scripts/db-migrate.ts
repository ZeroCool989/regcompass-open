import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigration } from '../lib/db-migrate';

/**
 * Standalone migration CLI (used by `regcompass-open setup`, the installers, and
 * imported by scripts/start.ts). Runs the safe runner against the resolved
 * DATABASE_URL and exits non-zero on any failure so a launcher never starts the
 * server against an un-migrated or unsafe database.
 */
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function migrateOrExit(selfPid?: number): Promise<void> {
  try {
    const r = await runMigration({ appVersion: appVersion(), selfPid });
    if (r.action !== 'noop') {
      console.log(`› Database ${r.action}${r.backupPath ? ` (backup: ${r.backupPath})` : ''}.`);
    }
  } catch (err) {
    console.error('\n✗ Database migration/verification failed — not starting RegCompass.');
    console.error('  ' + (err instanceof Error ? err.message : String(err)));
    console.error('  Your data was left as-is (a verified backup is kept when one was made).\n');
    process.exit(1);
  }
}

// When run directly (not imported), migrate and exit.
if (process.argv[1] && process.argv[1].endsWith('db-migrate.ts')) {
  void migrateOrExit().then(() => process.exit(0));
}
