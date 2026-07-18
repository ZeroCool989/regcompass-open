import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import {
  claudeOAuthConfig,
  decodePkceCookie,
  exchangeCode,
  PKCE_COOKIE,
  resolveCallbackUrl,
  storeConnection,
  verifyOAuthState,
} from '@/lib/aegis/claude-oauth';

/**
 * D10 "Sign in with Claude" — step 2: claude.ai redirects back here with
 * ?code&state. Validates state against the httpOnly PKCE cookie (CSRF +
 * single-use), exchanges the code, stores encrypted tokens, and returns the
 * user to the settings page. All failures land on the settings page with a
 * German message key — never a raw error page, never token material in logs.
 */

function settingsRedirect(req: NextRequest, outcome: 'connected' | 'error', detail?: string) {
  const url = new URL('/account/providers', process.env.APP_BASE_URL || req.nextUrl.origin);
  url.searchParams.set('claude', outcome);
  if (detail) url.searchParams.set('reason', detail);
  const res = NextResponse.redirect(url, { status: 302 });
  res.cookies.delete(PKCE_COOKIE); // single-use: the cookie dies with this attempt
  return res;
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return settingsRedirect(req, 'error', 'session');
  }
  const config = claudeOAuthConfig();
  if (!config) return settingsRedirect(req, 'error', 'setup');

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const providerError = req.nextUrl.searchParams.get('error');
  if (providerError) return settingsRedirect(req, 'error', 'denied');
  if (!code || !state) return settingsRedirect(req, 'error', 'missing');

  const cookieRaw = req.cookies.get(PKCE_COOKIE)?.value;
  const pkce = cookieRaw ? decodePkceCookie(cookieRaw) : null;
  if (!pkce || pkce.state !== state || pkce.userId !== user.id || !verifyOAuthState(state, user.id)) {
    return settingsRedirect(req, 'error', 'state');
  }

  try {
    const tokens = await exchangeCode({
      config,
      code,
      verifier: pkce.verifier,
      redirectUri: resolveCallbackUrl(req.nextUrl.origin),
    });
    await storeConnection(user.id, tokens);
    return settingsRedirect(req, 'connected');
  } catch {
    return settingsRedirect(req, 'error', 'exchange');
  }
}
