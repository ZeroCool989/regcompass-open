import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, requireAdmin } from '@/lib/auth';
import { checkCronAuth } from '@/lib/regulatory/cron-auth';
import { isHostedDeployment } from '@/lib/deployment';
import { runRegulatoryRadar } from '@/lib/regulatory/store';

/**
 * Refresh the regulatory news feed. Two callers:
 *  - a scheduled job / cron: authenticates with `Authorization: Bearer
 *    ${CRON_SECRET}` (checkCronAuth); locally, with no secret set, it is
 *    curl-able for manual runs.
 *  - the in-app "Jetzt aktualisieren" button: an approved admin (the local
 *    owner in the default single-user build) is allowed without a secret.
 *
 * The backend is LLM-free by default (RSS feeds); set REGULATORY_NEWS_PROVIDER=
 * llm to use Claude instead. The radar always writes a run-log row.
 */
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!requireAdmin(user)) {
    const auth = checkCronAuth(req.headers.get('authorization'), {
      secret: process.env.CRON_SECRET,
      deployed: isHostedDeployment(),
    });
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, message: auth.message }, { status: auth.status });
    }
  }

  try {
    const summary = await runRegulatoryRadar();
    return NextResponse.json(summary);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'regulatory_refresh_failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json(
      { error: 'refresh_failed', message: 'Aktualisierung fehlgeschlagen. Details siehe Server-Log.' },
      { status: 500 },
    );
  }
}
