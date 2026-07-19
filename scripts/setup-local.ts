/**
 * One-time local setup. The SQLite schema is created by `pnpm db:push`; this
 * script only reports the account state — accounts themselves are created in
 * the browser: the first registration on a fresh database becomes the approved
 * admin (app/api/auth/register). Idempotent — safe to re-run.
 *
 * Run (loads .env for DATABASE_URL): pnpm setup
 */
import { db } from '@/lib/db';

async function main() {
  const users = await db.user.count();
  if (users === 0) {
    console.log('Database ready. No accounts yet — open /register in the browser;');
    console.log('the first account automatically becomes the approved admin.');
  } else {
    console.log(`Database ready. ${users} account(s) exist — sign in at /login.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
