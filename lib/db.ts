import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/app/generated/prisma/client';

/**
 * Prisma client for the local SQLite database. A single local process talks to
 * a file-backed database via the better-sqlite3 driver adapter — no connection
 * pool or cold-start retry to manage. One client, reused across hot reloads.
 */

/**
 * Retained as a pass-through so existing call sites keep working. The Neon
 * cold-start retry it used to provide is unnecessary against local SQLite.
 */
export async function withDbRetry<T>(op: () => Promise<T>): Promise<T> {
  return op();
}

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'file:./local.db';
}

function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl() });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

type PrismaClientSingleton = ReturnType<typeof createPrismaClient>;
const globalForPrisma = globalThis as unknown as { prisma: PrismaClientSingleton | undefined };

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
