/**
 * Seed the allowlisted accounts. With public registration removed, this is the
 * ONLY way real accounts are created. Idempotent: re-running updates the password
 * and re-asserts APPROVED status / role for every AUTH_ALLOWLIST email.
 *
 * Reads:
 *   AUTH_ALLOWLIST  comma/space-separated emails that may authenticate.
 *   ADMIN_EMAILS    subset of AUTH_ALLOWLIST that also gets the ADMIN role.
 *   SEED_PASSWORD   plaintext password applied to every seeded account THIS run.
 *                   Never hardcoded, never committed — supply it per run.
 *   DATABASE_URL    (+ DIRECT_URL) for the Prisma connection.
 *
 * Run (loads .env for DATABASE_URL etc.):
 *   SEED_PASSWORD='…' tsx --env-file=.env scripts/seed-users.ts
 * or, with the env already exported in your shell:
 *   npm run seed:users
 */
import { db } from '@/lib/db';
import { adminEmails, allowlistEmails, hashPassword, isAdminEmail } from '@/lib/auth';

async function main() {
  const allow = allowlistEmails();
  if (allow.size === 0) {
    throw new Error(
      'AUTH_ALLOWLIST is empty — nothing to seed. Set it to the emails that may log in.',
    );
  }

  // ADMIN_EMAILS must be a subset of AUTH_ALLOWLIST: an admin who can't even
  // authenticate is a misconfiguration. Fail loud rather than seed half a set.
  const stray = [...adminEmails()].filter((e) => !allow.has(e));
  if (stray.length > 0) {
    throw new Error(
      `ADMIN_EMAILS contains ${stray.length} email(s) not in AUTH_ALLOWLIST: ` +
        `${stray.join(', ')}. Add them to AUTH_ALLOWLIST or remove them from ADMIN_EMAILS.`,
    );
  }

  const password = process.env.SEED_PASSWORD ?? '';
  if (password.length < 8) {
    throw new Error(
      'SEED_PASSWORD is unset or shorter than 8 chars — refusing to seed weak/empty passwords.',
    );
  }

  // SEC-7: a rerun must never silently reset existing accounts to the shared
  // seed password (users may have changed theirs via the reset flow). Existing
  // accounts keep their passwordHash; only role/status are reconciled. Set
  // SEED_FORCE_PASSWORD=1 to explicitly overwrite (announced per account).
  const forcePassword = process.env.SEED_FORCE_PASSWORD === '1';

  let created = 0;
  let updated = 0;
  for (const email of allow) {
    const role = isAdminEmail(email) ? 'ADMIN' : 'USER';
    const existing = await db.user.findUnique({ where: { email } });
    const data = {
      status: 'APPROVED' as const,
      role: role as 'ADMIN' | 'USER',
      // Preserve the original approval timestamp; only stamp it on first create.
      approvedAt: existing?.approvedAt ?? new Date(),
    };
    if (existing) {
      await db.user.update({
        where: { email },
        data: forcePassword ? { ...data, passwordHash: hashPassword(password) } : data,
      });
      updated++;
      console.log(
        `  ~ updated  ${email}  (${role})${forcePassword ? '  [password OVERWRITTEN]' : '  [password preserved]'}`,
      );
    } else {
      await db.user.create({
        data: { email, passwordHash: hashPassword(password), ...data },
      });
      created++;
      console.log(`  + created  ${email}  (${role})`);
    }
  }
  console.log(`\nDone. ${created} created, ${updated} updated (${allow.size} allowlisted).`);
}

main()
  .catch((err) => {
    console.error('seed:users failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
