import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';

/**
 * Fixed-window rate limiter backed by Postgres (`RateLimitBucket`), so the
 * limit holds across serverless instances and cold starts — the previous
 * in-memory Map effectively multiplied the limit by the instance count.
 *
 * The counter update is a single atomic INSERT … ON CONFLICT, so concurrent
 * requests from different instances cannot double-spend a window.
 *
 * Fails OPEN: if the database is unreachable the request is allowed (and the
 * failure logged) — rate limiting must never take the product down with it.
 */

type CheckResult = { ok: boolean; remaining: number; resetAt: number };

export function rateLimit(options: {
  key: string;
  limit: number;
  windowMs: number;
}) {
  const windowSec = Math.max(1, Math.ceil(options.windowMs / 1000));

  return {
    async check(identifier: string): Promise<CheckResult> {
      const bucketKey = `${options.key}:${identifier}`;
      try {
        const rows = await db.$queryRaw<Array<{ count: number; resetAt: Date }>>`
          INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
          VALUES (${bucketKey}, 1, now() + make_interval(secs => ${windowSec}))
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE
              WHEN "RateLimitBucket"."resetAt" <= now() THEN 1
              ELSE "RateLimitBucket"."count" + 1
            END,
            "resetAt" = CASE
              WHEN "RateLimitBucket"."resetAt" <= now() THEN now() + make_interval(secs => ${windowSec})
              ELSE "RateLimitBucket"."resetAt"
            END
          RETURNING "count", "resetAt"
        `;
        const row = rows[0];
        const count = Number(row.count);
        return {
          ok: count <= options.limit,
          remaining: Math.max(0, options.limit - count),
          resetAt: row.resetAt.getTime(),
        };
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'rate_limit_unavailable',
            level: 'warn',
            key: options.key,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        return {
          ok: true,
          remaining: options.limit,
          resetAt: Date.now() + options.windowMs,
        };
      }
    },
  };
}

/**
 * Stable, non-reversible per-IP identifier for rate limiting. Shared by the
 * AEGIS chat and upload routes.
 */
export function ipHash(req: NextRequest): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return createHash('sha256').update(ip).digest('hex');
}
