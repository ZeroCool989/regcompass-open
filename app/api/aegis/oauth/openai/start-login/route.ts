import { NextResponse, type NextRequest } from 'next/server';
import { spawn } from 'node:child_process';
import { getUserFromRequest, isApproved } from '@/lib/auth';

/**
 * POST → Launch the openai-oauth login flow. Opens the user's browser to
 * ChatGPT's login page. The CLI writes the resulting auth token to
 * ~/.codex/auth.json, which the codex-login endpoint picks up and imports.
 *
 * This replaces the manual "run npx openai-oauth login in the terminal" step
 * so the user just clicks a button.
 */

let loginProcess: ReturnType<typeof spawn> | null = null;

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Don't spawn duplicates — if one is already running, let it finish.
  if (loginProcess && loginProcess.exitCode === null) {
    return NextResponse.json({
      started: true,
      message: 'Login-Fenster wurde bereits geöffnet. Bitte dort anmelden.',
    });
  }

  try {
    // Spawn the login flow — it opens the browser and writes the token.
    loginProcess = spawn('npx', ['openai-oauth@latest', 'login'], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, BROWSER: 'true' },
    });

    // Don't block the Node process exit on this child.
    loginProcess.unref();

    // Clean up reference when it exits.
    loginProcess.on('exit', () => {
      loginProcess = null;
    });

    return NextResponse.json({
      started: true,
      message: 'Login-Fenster wird geöffnet. Bitte bei ChatGPT anmelden.',
    });
  } catch (err) {
    return NextResponse.json(
      {
        started: false,
        message: `Login konnte nicht gestartet werden: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`,
      },
      { status: 500 },
    );
  }
}
