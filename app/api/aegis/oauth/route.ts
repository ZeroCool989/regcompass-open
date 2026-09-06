import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { parseProviderId } from '@/lib/aegis/oauth/registry';
import { allProviderViews, disconnect, setSubscriptionModel } from '@/lib/aegis/oauth';
import { OPENAI_MODEL_OPTIONS } from '@/lib/aegis/provider-settings';

/**
 * Subscription connection status + disconnect + model preference.
 * GET    → the three-state view (unconfigured | disconnected | connected) per
 *          provider; no secrets are ever returned.
 * PATCH  → update the preferred model for a connected subscription.
 * DELETE ?provider=<id> → remove a stored connection.
 */

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ providers: allProviderViews() });
}

export async function PATCH(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json()) as { provider?: string; model?: string };
  const id = parseProviderId(body.provider);
  if (!id) return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });
  const model = typeof body.model === 'string' ? body.model.trim() : null;
  // Validate against curated options for OpenAI.
  if (id === 'openai' && model && !OPENAI_MODEL_OPTIONS.some((o) => o.id === model)) {
    return NextResponse.json({ error: 'unknown_model' }, { status: 400 });
  }
  setSubscriptionModel(id, model);
  return NextResponse.json({ ok: true, model });
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
