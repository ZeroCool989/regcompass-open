import { NextResponse, type NextRequest } from 'next/server';
import { KB } from '@/lib/kb';
import { KbManifest } from '@/lib/kb/types';
import {
  summarizeManifest,
  buildUpdateStatus,
  kbUpdateBaseUrl,
  type KbVersionInfo,
} from '@/lib/kb/version';

/**
 * KB version info for the in-app banner.
 *
 * - `GET /api/kb/version`         → the locally bundled KB version (no network).
 * - `GET /api/kb/version?check=1` → additionally fetches the remote manifest
 *   (public JSON, no user data sent) and reports whether an update exists.
 *
 * The remote check is opt-in via the query param so normal page loads stay
 * fast and work fully offline. Applying an update is a CLI action
 * (`pnpm kb:update`) — the running app never rewrites its own bundle.
 */
export async function GET(req: NextRequest) {
  const local = summarizeManifest(KB.manifest);
  const check = new URL(req.url).searchParams.get('check');

  if (check !== '1') {
    return NextResponse.json({ local, remote: null, updateAvailable: false });
  }

  let remote: KbVersionInfo | null = null;
  try {
    const res = await fetch(`${kbUpdateBaseUrl()}/manifest.json`, {
      // Never let a hung mirror block the request indefinitely.
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      remote = summarizeManifest(KbManifest.parse(await res.json()));
    }
  } catch {
    // Offline or unreachable mirror → treat as "no update info", not an error.
    remote = null;
  }

  return NextResponse.json(buildUpdateStatus(local, remote));
}
