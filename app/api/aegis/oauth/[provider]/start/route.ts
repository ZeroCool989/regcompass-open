import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { cookiesSecure } from '@/lib/deployment';
import { parseProviderId } from '@/lib/aegis/oauth/registry';
import { PKCE_COOKIE, startConnect } from '@/lib/aegis/oauth';

/**
 * Subscription connect — step 1: redirect the browser to the provider's
 * authorize endpoint (loopback flow, RFC 8252). The PKCE verifier travels in an
 * encrypted, httpOnly cookie scoped to the callback path, so it is opaque to
 * page scripts and single-use per attempt. When the provider has no OAuth client
 * registered yet, this answers 409 with a setup message instead of a broken
 * redirect.
 */

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  }
  const id = parseProviderId((await ctx.params).provider);
  if (!id) return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });

  const started = startConnect(id, user.id, req.nextUrl.origin);
  if (!started) {
    return NextResponse.json(
      { error: 'setup_required', message: 'Setup erforderlich: Für diesen Anbieter ist noch kein OAuth-Client hinterlegt.' },
      { status: 409 },
    );
  }
  const res = NextResponse.redirect(started.authorizeUrl, { status: 302 });
  res.cookies.set(PKCE_COOKIE, started.cookie, {
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: 'lax',
    path: `/api/aegis/oauth/${id}`,
    maxAge: 600,
  });
  return res;
}
