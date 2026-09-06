import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import { importCodexAuth, hasCodexAuth } from '@/lib/aegis/oauth/codex-bridge';
import { setAegisProvider } from '@/lib/aegis/provider-settings';

/**
 * Codex-based ChatGPT subscription connect.
 *
 * POST → check for / import an existing Codex auth token.
 * The actual browser-based login happens client-side via a shell command
 * (`npx openai-oauth login`) that opens the ChatGPT sign-in page — this
 * endpoint just checks whether a token has appeared and imports it.
 *
 * On successful import, also sets the user's aegisProvider to 'chatgpt-codex'
 * so AEGIS dispatches to OpenAI automatically.
 */

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!hasCodexAuth()) {
    return NextResponse.json({
      connected: false,
      message: 'Kein Codex-Token gefunden. Bitte zuerst `npx openai-oauth login` ausführen.',
    });
  }

  const ok = importCodexAuth();
  if (ok) {
    // Auto-select ChatGPT as the AEGIS provider so the user doesn't have to
    // configure it separately — connecting the subscription is the selection.
    try {
      await setAegisProvider(user.id, 'chatgpt-codex');
    } catch {
      // Non-blocking: the token is stored, provider selection is a convenience.
    }
  }
  return NextResponse.json({
    connected: ok,
    message: ok
      ? 'ChatGPT-Abo erfolgreich verbunden!'
      : 'Codex-Token konnte nicht importiert werden.',
  });
}
