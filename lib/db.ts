import { PrismaClient } from '@/app/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma client with transparent retry for Neon cold-starts.
 *
 * Neon's free tier scales the compute to zero after a few minutes idle. The
 * FIRST query after that wakes it, and if the wake outlasts the connect timeout
 * the driver surfaces `P1001: Can't reach database server` — even though the
 * database is healthy. We retry ONLY connection-establishment failures (the
 * query never executed), so retrying is safe for reads and writes alike, and a
 * short backoff gives the compute time to wake.
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 300;

/**
 * True only for errors that mean the connection was never established (so the
 * query did NOT run and is safe to retry). Mid-query failures are NOT retried.
 */
export function isRetryableConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'P1001' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /can't reach database server|connection refused|connect etimedout|getaddrinfo|connection timed out/i.test(
    msg,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `op`, retrying transient connection-establishment failures with a short
 * incremental backoff. Non-connection errors propagate immediately.
 */
export async function withDbRetry<T>(
  op: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryableConnectionError(err)) throw err;
      console.warn(
        JSON.stringify({ event: 'db_retry', attempt: attempt + 1, maxRetries, reason: 'connection' }),
      );
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
  // Wrap EVERY operation (model queries + $queryRaw/$executeRaw) so a Neon
  // cold-start is retried transparently instead of bubbling up as an error.
  return base.$extends({
    query: {
      $allOperations({ args, query }) {
        return withDbRetry(() => query(args));
      },
    },
  });
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
const globalForPrisma = globalThis as unknown as { prisma: ExtendedPrismaClient | undefined };

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
