import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { parseProviderId } from '@/lib/aegis/oauth/registry';
import { allProviderViews, disconnect } from '@/lib/aegis/oauth';

/**
 * Subscription connection status + disconnect for the local account page.
 * GET  → the three-state view (unconfigured | disconnected | connected) per
 *        provider; no secrets are ever returned.
 * DELETE ?provider=<id> → remove a stored connection.
 */

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ providers: allProviderViews() });
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const id = parseProviderId(req.nextUrl.searchParams.get('provider'));
  if (!id) return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });
  disconnect(id);
  return NextResponse.json({ ok: true });
}
