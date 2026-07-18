import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { parseProviderId } from '@/lib/aegis/oauth/registry';
import { completeCallback, decodePkceCookie, PKCE_COOKIE } from '@/lib/aegis/oauth';

/**
 * Subscription connect — step 2: the provider redirects back here with
 * ?code&state. Validates state against the httpOnly PKCE cookie (CSRF +
 * single-use), exchanges the code for tokens, stores them in the local
 * credential file, and returns to the settings page. Every failure lands on the
 * settings page with a short reason — never a raw error page, never token
 * material in logs. The cookie is always cleared.
 */

function settingsRedirect(
  req: NextRequest,
  provider: string,
  outcome: 'connected' | 'error',
  reason?: string,
) {
  const url = new URL('/account/providers', process.env.APP_BASE_URL || req.nextUrl.origin);
  url.searchParams.set('subscription', provider);
  url.searchParams.set('result', outcome);
  if (reason) url.searchParams.set('reason', reason);
  const res = NextResponse.redirect(url, { status: 302 });
  res.cookies.delete(PKCE_COOKIE);
  return res;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const providerParam = (await ctx.params).provider;
  const id = parseProviderId(providerParam);
  if (!id) return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });

  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) return settingsRedirect(req, id, 'error', 'session');

  if (req.nextUrl.searchParams.get('error')) return settingsRedirect(req, id, 'error', 'denied');
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state) return settingsRedirect(req, id, 'error', 'missing');

  const cookieRaw = req.cookies.get(PKCE_COOKIE)?.value;
  const cookie = cookieRaw ? decodePkceCookie(cookieRaw) : null;

  const outcome = await completeCallback({
    id,
    userId: user.id,
    origin: req.nextUrl.origin,
    code,
    state,
    cookie,
  });
  return settingsRedirect(req, id, outcome.ok ? 'connected' : 'error', outcome.ok ? undefined : outcome.reason);
}
