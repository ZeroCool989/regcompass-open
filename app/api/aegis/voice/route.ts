import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  DEFAULT_VOICE_ID,
  isValidVoiceId,
  normalizeVoicePrefs,
  resolveVoiceId,
} from '@/lib/aegis/voices';

/** The user's stored voice preference + prefs + the resolved (effective) voice. */
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }
  return NextResponse.json({
    voiceId: user.voiceId ?? null,
    resolved: resolveVoiceId(user.voiceId),
    defaultVoiceId: DEFAULT_VOICE_ID,
    prefs: normalizeVoicePrefs(user.voicePrefs),
  });
}

/** Update the user's voice preference and/or experience prefs. */
export async function PUT(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Bad JSON.' }, { status: 400 });
  }
  const b = body as { voiceId?: unknown; prefs?: unknown };

  const data: { voiceId?: string | null; voicePrefs?: object } = {};

  if ('voiceId' in b) {
    const voiceId = b.voiceId == null || b.voiceId === '' ? null : String(b.voiceId);
    if (!isValidVoiceId(voiceId)) {
      return NextResponse.json(
        { error: 'invalid_voice', message: 'Unbekannte Stimme.' },
        { status: 400 },
      );
    }
    data.voiceId = voiceId;
  }
  if ('prefs' in b) {
    data.voicePrefs = normalizeVoicePrefs(b.prefs) as unknown as object;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'invalid_input', message: 'Nichts zu ändern.' }, { status: 400 });
  }

  const updated = await db.user.update({ where: { id: user.id }, data, select: { voiceId: true, voicePrefs: true } });
  return NextResponse.json({
    voiceId: updated.voiceId,
    resolved: resolveVoiceId(updated.voiceId),
    prefs: normalizeVoicePrefs(updated.voicePrefs),
  });
}
