import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved, isDeployedEnv } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import {
  buildAuthorizeUrl,
  claudeOAuthConfig,
  encodePkceCookie,
  generatePkceVerifier,
  pkceChallenge,
  PKCE_COOKIE,
  resolveCallbackUrl,
  SETUP_REQUIRED_MESSAGE,
  signOAuthState,
} from '@/lib/aegis/claude-oauth';

/**
 * D10 "Sign in with Claude" — step 1: redirect to claude.ai/authorize.
 * Gated: without an Anthropic-issued client (env config) this answers 409
 * with a German setup message instead of a broken redirect.
 */

const limiter = rateLimit({ key: 'claude-oauth-start', limit: 10, windowMs: 15 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  }
  if (!(await limiter.check(`user:${user.id}`)).ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Zu viele Versuche. Bitte kurz warten.' },
      { status: 429 },
    );
  }
  const config = claudeOAuthConfig();
  if (!config) {
    return NextResponse.json({ error: 'setup_required', message: SETUP_REQUIRED_MESSAGE }, { status: 409 });
  }
  const state = signOAuthState(user.id);
  const verifier = generatePkceVerifier();
  const authorize = buildAuthorizeUrl({
    config,
    redirectUri: resolveCallbackUrl(req.nextUrl.origin),
    state,
    challenge: pkceChallenge(verifier),
  });
  const res = NextResponse.redirect(authorize, { status: 302 });
  res.cookies.set(PKCE_COOKIE, encodePkceCookie({ state, verifier, userId: user.id }), {
    httpOnly: true,
    secure: isDeployedEnv(),
    sameSite: 'lax',
    path: '/api/aegis/providers/claude-oauth',
    maxAge: 600,
  });
  return res;
}
