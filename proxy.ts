import { NextResponse, type NextRequest } from 'next/server';

/**
 * Issues the anonymous session cookie on every request that doesn't already
 * carry a valid one. The signing scheme (HMAC-SHA256 hex over a UUID) must
 * stay byte-identical to `lib/session.ts` — this file cannot import it because
 * proxy runs on the edge runtime, where `node:crypto` is unavailable, so the
 * HMAC is implemented with Web Crypto here.
 */

const SESSION_COOKIE = 'rc_session';
const FALLBACK_SECRET = 'rc-dev-insecure-session-secret';

/**
 * True on Vercel production/preview, or any NODE_ENV=production build. Kept
 * byte-identical to `lib/session.ts` — a missing secret must fail LOUD here too
 * rather than mint cookies with the insecure dev key.
 */
function isDeployedEnv(): boolean {
  const v = process.env.VERCEL_ENV;
  return v === 'production' || v === 'preview' || process.env.NODE_ENV === 'production';
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (isDeployedEnv()) {
    throw new Error(
      'SESSION_SECRET is unset or shorter than 16 chars in a deployed environment — ' +
        'refusing to issue sessions with the insecure dev fallback.',
    );
  }
  return FALLBACK_SECRET;
}

async function hmacHex(id: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(id));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function isValid(value: string): Promise<boolean> {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  return value.slice(dot + 1) === (await hmacHex(value.slice(0, dot)));
}

export async function proxy(req: NextRequest) {
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  if (existing && (await isValid(existing))) {
    return NextResponse.next();
  }

  const id = crypto.randomUUID();
  const res = NextResponse.next();
  res.cookies.set({
    name: SESSION_COOKIE,
    value: `${id}.${await hmacHex(id)}`,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export const config = {
  // Everything except Next.js static assets — API routes included, so direct
  // API callers get a session too.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
