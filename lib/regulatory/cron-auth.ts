/**
 * Cron-endpoint authentication, factored out so it is unit-testable and shared.
 *
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` when the env var is set.
 * In a deployed environment an UNSET secret is a hard failure (503) — the radar
 * must never run open to the public internet. Locally (no deployed env, no
 * secret) the route stays curl-able for manual testing.
 */
export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string };

export function isDeployedEnv(): boolean {
  const v = process.env.VERCEL_ENV;
  return v === 'production' || v === 'preview' || process.env.NODE_ENV === 'production';
}

export function checkCronAuth(
  authHeader: string | null,
  opts: { secret: string | undefined; deployed: boolean },
): CronAuthResult {
  if (opts.deployed && !opts.secret) {
    return {
      ok: false,
      status: 503,
      error: 'cron_secret_missing',
      message: 'CRON_SECRET ist in einer deployten Umgebung nicht gesetzt.',
    };
  }
  if (opts.secret && authHeader !== `Bearer ${opts.secret}`) {
    return { ok: false, status: 401, error: 'unauthorized', message: 'Ungültiges Cron-Secret.' };
  }
  return { ok: true };
}
