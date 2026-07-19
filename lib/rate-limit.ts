import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Fixed-window rate limiter, in-memory. This build runs as a single Node
 * process on one machine, so a process-local Map is the right store — no
 * external dependency, and a restart harmlessly resets the counters. Used to
 * throttle credential guessing on the auth endpoints.
 */

type CheckResult = { ok: boolean; remaining: number; resetAt: number };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(options: { key: string; limit: number; windowMs: number }) {
  return {
    async check(identifier: string): Promise<CheckResult> {
      const now = Date.now();
      const bucketKey = `${options.key}:${identifier}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + options.windowMs };
        buckets.set(bucketKey, bucket);
      }
      bucket.count += 1;
      return {
        ok: bucket.count <= options.limit,
        remaining: Math.max(0, options.limit - bucket.count),
        resetAt: bucket.resetAt,
      };
    },
  };
}

/** Stable, non-reversible per-caller identifier. */
export function ipHash(req: NextRequest): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  return createHash('sha256').update(ip).digest('hex');
}
