import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Rate limiting is a no-op in the local single-user build: there is one user on
 * one machine, so there is nothing to throttle. The API is preserved so callers
 * compile and behave unchanged (every check is allowed).
 */

type CheckResult = { ok: boolean; remaining: number; resetAt: number };

export function rateLimit(options: { key: string; limit: number; windowMs: number }) {
  return {
    async check(_identifier: string): Promise<CheckResult> {
      void _identifier;
      return { ok: true, remaining: options.limit, resetAt: Date.now() + options.windowMs };
    },
  };
}

/**
 * Stable, non-reversible per-caller identifier. Retained for call-site
 * compatibility; in the local build every caller is the same user.
 */
export function ipHash(req: NextRequest): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  return createHash('sha256').update(ip).digest('hex');
}
