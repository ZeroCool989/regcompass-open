import { NextResponse, type NextRequest } from 'next/server';
import { ipHash, rateLimit } from '@/lib/rate-limit';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import {
  DEFAULT_CARTESIA_VOICE_ID,
  isKnownCartesiaVoice,
} from '@/lib/aegis/cartesia-voices';

/**
 * Cartesia TTS bridge for the in-app "Vorlesen" feature.
 *
 * The browser's Web Speech voices need no server (AegisTtsButton handles them
 * directly). The "Marlene" option is a Cartesia (sonic-3) cloud voice, so it
 * MUST be synthesized server-side — the Cartesia key never reaches the client.
 * This route is the one place the web app talks to Cartesia; the standalone
 * voice-gateway service is a separate concern.
 *
 * Residency note: Cartesia is third-party (cloud). This is fine for the
 * internal demo. Before real client data, this voice should move to the
 * in-infra TTS path (see services/voice-gateway: assertTtsResidencyAllowed).
 */

const ttsLimiter = rateLimit({
  key: 'aegis-tts',
  limit: 60,
  windowMs: 60 * 60 * 1000,
});

// Cartesia rejects very long transcripts; the read-aloud text is already
// stripped of markdown client-side, so this is a sanity ceiling, not a budget.
const MAX_CHARS = 4000;

export async function POST(req: NextRequest) {
  const limit = await ttsLimiter.check(ipHash(req));
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'TTS rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  // Gated behind approval like the rest of AEGIS — cloud TTS costs money too.
  if (!isApproved(await getUserFromRequest(req))) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Anmeldung erforderlich.' },
      { status: 401 },
    );
  }

  const apiKey = process.env.CARTESIA_API_KEY;
  const model = process.env.CARTESIA_MODEL || 'sonic-3';
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'tts_not_configured',
        message: 'Cartesia voice is not configured. Set CARTESIA_API_KEY.',
        fallback: 'browser',
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }
  const text = (body as { text?: unknown })?.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'Field "text" must be a non-empty string.' },
      { status: 400 },
    );
  }
  const transcript = text.slice(0, MAX_CHARS);

  // Resolve the voice: a client-requested id only if it's on the German
  // allowlist; otherwise the env override, otherwise Marlene. This keeps the
  // route from proxying arbitrary Cartesia voices.
  const requested = (body as { voiceId?: unknown })?.voiceId;
  const voiceId =
    typeof requested === 'string' && isKnownCartesiaVoice(requested)
      ? requested
      : process.env.CARTESIA_VOICE_ID || DEFAULT_CARTESIA_VOICE_ID;

  let res: Response;
  try {
    res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': '2025-04-16',
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: model,
        transcript,
        voice: { mode: 'id', id: voiceId },
        language: 'de',
        // MP3 so the browser can stream-decode chunks as they arrive (playback
        // starts on the first chunk instead of waiting for the whole clip).
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      }),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'tts_upstream_unreachable',
        message: err instanceof Error ? err.message : 'Cartesia request failed.',
        fallback: 'browser',
      },
      { status: 502 },
    );
  }

  // API-key limit / quota / auth (429 rate limit, 402 payment, 403 forbidden):
  // signal the client to fall back to the browser voice. 401/403 also covers a
  // revoked/exhausted key. Logged so quota exhaustion is observable.
  if (res.status === 429 || res.status === 402 || res.status === 401 || res.status === 403) {
    console.warn(
      JSON.stringify({ event: 'tts_provider_limit', level: 'warn', status: res.status }),
    );
    return NextResponse.json(
      { error: 'tts_limit', message: 'Cartesia-Limit erreicht.', fallback: 'browser' },
      { status: 503, headers: { 'Retry-After': '60' } },
    );
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    return NextResponse.json(
      {
        error: 'tts_upstream_error',
        message: `Cartesia TTS ${res.status}`,
        detail: detail.slice(0, 300),
        fallback: 'browser',
      },
      { status: 502 },
    );
  }

  // Stream the WAV body straight through so playback can start before the
  // whole clip has been synthesized.
  return new Response(res.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  });
}
