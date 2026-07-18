/**
 * One-time local setup: ensure the local user row exists. The SQLite schema is
 * created by `pnpm db:push`; this seeds the single local identity every request
 * resolves to. Idempotent — safe to re-run.
 *
 * Run (loads .env for DATABASE_URL): pnpm setup
 */
import { ensureLocalUser } from '@/lib/auth';

async function main() {
  const user = await ensureLocalUser();
  console.log(`Local user ready: ${user.email} (${user.id}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
