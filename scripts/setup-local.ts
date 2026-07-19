/**
 * One-time local setup. The SQLite schema is created by `pnpm db:push`.
 *
 * Default (AUTH_MODE unset / 'local'): provision the implicit local user —
 * no login, the app is ready as soon as a model brain is configured.
 * AUTH_MODE=multi: accounts are created in the browser instead — the first
 * registration on a fresh database becomes the approved admin.
 *
 * Idempotent — safe to re-run. Run (loads .env for DATABASE_URL): pnpm setup
 */
import { authMode, ensureLocalUser } from '@/lib/auth';
import { db } from '@/lib/db';

async function main() {
  if (authMode() === 'local') {
    const user = await ensureLocalUser();
    console.log(`Local user ready: ${user.email} (${user.id}). No login required.`);
    return;
  }
  const users = await db.user.count({ where: { NOT: { passwordHash: '' } } });
  if (users === 0) {
    console.log('Database ready (AUTH_MODE=multi). No accounts yet — open /register;');
    console.log('the first account automatically becomes the approved admin.');
  } else {
    console.log(`Database ready (AUTH_MODE=multi). ${users} account(s) exist — sign in at /login.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
