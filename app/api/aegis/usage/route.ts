import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { db } from '@/lib/db';

/** Resolve the caller and require an APPROVED ADMIN; else null. */
async function requireAdmin(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.role !== 'ADMIN' || user.status !== 'APPROVED') return null;
  return user;
}

type Summary = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  /** Cost of ALL rows in the window. */
  totalCostCents: number;
  /** Cost of fix-era rows only (pricingVersion != 'legacy') — the console-comparable number. */
  comparableCostCents: number;
  /** Cost of legacy-priced rows excluded from the comparable total. */
  legacyCostCents: number;
  /** Count of legacy-priced rows excluded from the comparable total. */
  legacyRequests: number;
  avgLatencyMs: number;
  verifyPassRate: number;
};

type ByDay = {
  date: string;
  requests: number;
  costCents: number;
  /** Per-day cost excluding legacy rows — read this against the console Cost page for that day. */
  comparableCostCents: number;
  avgLatencyMs: number;
};

type ByModel = {
  model: string;
  requests: number;
  costCents: number;
  avgTokensIn: number;
  avgTokensOut: number;
};

type ByMode = {
  mode: string;
  requests: number;
  costCents: number;
  avgLatencyMs: number;
  verifyPassRate: number;
};

/** Exit-reason breakdown — scoped to fix-era rows (legacy rows have no real exitReason). */
type ByExitReason = {
  exitReason: string;
  requests: number;
  costCents: number;
};

/** Guardrail action OCCURRENCES (a run that compacts twice contributes two `compress`). */
type ByGuardrail = {
  token: string;
  count: number;
};

/** Served-model distribution — INFORMATIONAL only (not a drift signal; drift lives in the per-call event stream). */
type ByServedModel = {
  servedModel: string;
  requests: number;
  costCents: number;
};

type RecentCall = {
  id: string;
  createdAt: string;
  mode: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  verifyPassed: boolean;
  citationCount: number;
};

type UsageResponse = {
  summary: Summary;
  byDay: ByDay[];
  byModel: ByModel[];
  byMode: ByMode[];
  byExitReason: ByExitReason[];
  byGuardrail: ByGuardrail[];
  byServedModel: ByServedModel[];
  recentCalls: RecentCall[];
};

// Postgres returns numerics as strings via raw queries; coerce defensively.
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function parseDays(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get('days');
  const n = raw ? Number(raw) : 7;
  if (!Number.isFinite(n) || n <= 0) return 7;
  // Hard ceiling so we never scan all-time on a 50M-row table.
  return Math.min(Math.floor(n), 365);
}

export async function GET(req: NextRequest): Promise<NextResponse<UsageResponse | { error: string }>> {
  // Usage telemetry (tokens, cost, exit reasons) is admin-only.
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const NON_LEGACY = { pricingVersion: { not: 'legacy' } } as const;

  try {
    const [
      agg,
      comparableAgg,
      verifyAgg,
      byModelRaw,
      byModeRaw,
      byModeVerifyRaw,
      byExitReasonRaw,
      byServedModelRaw,
      byGuardrailRaw,
      byDayRaw,
      recent,
    ] = await Promise.all([
      db.aegisUsageLog.aggregate({
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cachedTokens: true, costCents: true },
        _avg: { latencyMs: true },
      }),
      // Console-comparable cost: fix-era rows only.
      db.aegisUsageLog.aggregate({
        where: { createdAt: { gte: since }, ...NON_LEGACY },
        _count: { _all: true },
        _sum: { costCents: true },
      }),
      db.aegisUsageLog.count({
        where: { createdAt: { gte: since }, verifyPassed: true },
      }),
      db.aegisUsageLog.groupBy({
        by: ['model'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costCents: true },
        _avg: { inputTokens: true, outputTokens: true },
      }),
      db.aegisUsageLog.groupBy({
        by: ['mode'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costCents: true },
        _avg: { latencyMs: true },
      }),
      db.aegisUsageLog.groupBy({
        by: ['mode'],
        where: { createdAt: { gte: since }, verifyPassed: true },
        _count: { _all: true },
      }),
      // Exit reasons — fix-era rows only (legacy rows predate the column → "unknown").
      db.aegisUsageLog.groupBy({
        by: ['exitReason'],
        where: { createdAt: { gte: since }, ...NON_LEGACY },
        _count: { _all: true },
        _sum: { costCents: true },
      }),
      db.aegisUsageLog.groupBy({
        by: ['servedModel'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { costCents: true },
      }),
      // Guardrail occurrences: unnest the array column (Prisma can't groupBy an array).
      db.$queryRaw<Array<{ token: string; count: bigint | number }>>`
        SELECT unnest("guardrailsTriggered") AS token, COUNT(*)::int AS count
        FROM "AegisUsageLog"
        WHERE "createdAt" >= ${since}
        GROUP BY token
        ORDER BY count DESC
      `,
      // Per-day buckets, with a per-day console-comparable total via FILTER.
      db.$queryRaw<
        Array<{
          day: Date;
          requests: bigint | number;
          cost: number | null;
          comparable_cost: number | null;
          avg_latency: number | null;
        }>
      >`
        SELECT
          DATE_TRUNC('day', "createdAt")                                   AS day,
          COUNT(*)::int                                                    AS requests,
          SUM("costCents")                                                 AS cost,
          SUM("costCents") FILTER (WHERE "pricingVersion" <> 'legacy')     AS comparable_cost,
          AVG("latencyMs")                                                 AS avg_latency
        FROM "AegisUsageLog"
        WHERE "createdAt" >= ${since}
        GROUP BY day
        ORDER BY day ASC
      `,
      db.aegisUsageLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          mode: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
          costCents: true,
          latencyMs: true,
          verifyPassed: true,
          citationCount: true,
        },
      }),
    ]);

    const totalRequests = agg._count._all;
    const totalCostCents = agg._sum.costCents ?? 0;
    const comparableCostCents = comparableAgg._sum.costCents ?? 0;
    const comparableRequests = comparableAgg._count._all;

    const summary: Summary = {
      totalRequests,
      totalInputTokens: agg._sum.inputTokens ?? 0,
      totalOutputTokens: agg._sum.outputTokens ?? 0,
      totalCachedTokens: agg._sum.cachedTokens ?? 0,
      totalCostCents,
      comparableCostCents,
      // Legacy = everything not in the comparable subset.
      legacyCostCents: totalCostCents - comparableCostCents,
      legacyRequests: totalRequests - comparableRequests,
      avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0),
      verifyPassRate: totalRequests > 0 ? verifyAgg / totalRequests : 0,
    };

    const byDay: ByDay[] = byDayRaw.map((row) => ({
      date: row.day.toISOString().slice(0, 10),
      requests: num(row.requests),
      costCents: num(row.cost),
      comparableCostCents: num(row.comparable_cost),
      avgLatencyMs: Math.round(num(row.avg_latency)),
    }));

    const byModel: ByModel[] = byModelRaw.map((row) => ({
      model: row.model,
      requests: row._count._all,
      costCents: row._sum.costCents ?? 0,
      avgTokensIn: Math.round(row._avg.inputTokens ?? 0),
      avgTokensOut: Math.round(row._avg.outputTokens ?? 0),
    }));

    const verifyByMode = new Map(byModeVerifyRaw.map((r) => [r.mode, r._count._all]));
    const byMode: ByMode[] = byModeRaw.map((row) => {
      const passCount = verifyByMode.get(row.mode) ?? 0;
      const requests = row._count._all;
      return {
        mode: row.mode,
        requests,
        costCents: row._sum.costCents ?? 0,
        avgLatencyMs: Math.round(row._avg.latencyMs ?? 0),
        verifyPassRate: requests > 0 ? passCount / requests : 0,
      };
    });

    const byExitReason: ByExitReason[] = byExitReasonRaw
      .map((row) => ({
        exitReason: row.exitReason,
        requests: row._count._all,
        costCents: row._sum.costCents ?? 0,
      }))
      .sort((a, b) => b.costCents - a.costCents);

    const byServedModel: ByServedModel[] = byServedModelRaw
      .map((row) => ({
        servedModel: row.servedModel ?? 'unknown',
        requests: row._count._all,
        costCents: row._sum.costCents ?? 0,
      }))
      .sort((a, b) => b.requests - a.requests);

    const byGuardrail: ByGuardrail[] = byGuardrailRaw.map((row) => ({
      token: row.token,
      count: num(row.count),
    }));

    const recentCalls: RecentCall[] = recent.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      mode: r.mode,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costCents: r.costCents,
      latencyMs: r.latencyMs,
      verifyPassed: r.verifyPassed,
      citationCount: r.citationCount,
    }));

    return NextResponse.json<UsageResponse>({
      summary,
      byDay,
      byModel,
      byMode,
      byExitReason,
      byGuardrail,
      byServedModel,
      recentCalls,
    });
  } catch (err) {
    console.error('[aegis usage] query failed:', err);
    return NextResponse.json(
      { error: 'Failed to load usage statistics.' },
      { status: 500 },
    );
  }
}
