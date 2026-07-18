import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { claudeOAuthStatus, disconnect, getConnectionView, SETUP_REQUIRED_MESSAGE } from '@/lib/aegis/claude-oauth';

/** D10: connection status + disconnect. Tokens never leave the server. */

async function approvedUser(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) return null;
  return user;
}

export async function GET(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  const status = claudeOAuthStatus();
  return NextResponse.json({
    status,
    setupMessage: status === 'unconfigured' ? SETUP_REQUIRED_MESSAGE : null,
    connection: await getConnectionView(user.id),
    // Honest until activation: stored connections do not power AEGIS yet.
    runtimeActive: false,
  });
}

export async function DELETE(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  await disconnect(user.id);
  return NextResponse.json({ ok: true, message: 'Claude-Verbindung getrennt.' });
}
