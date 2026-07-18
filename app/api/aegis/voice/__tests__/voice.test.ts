import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUserFromRequest } = vi.hoisted(() => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getUserFromRequest }));

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { user: { update } } }));

import { GET, PUT } from '../route';
import { DEFAULT_VOICE_ID } from '@/lib/aegis/voices';

const getReq = () => new NextRequest('http://localhost/api/aegis/voice');
const putReq = (body: unknown) =>
  new NextRequest('http://localhost/api/aegis/voice', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

afterEach(() => vi.clearAllMocks());

describe('GET /api/aegis/voice', () => {
  it('401 when not logged in', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await GET(getReq())).status).toBe(401);
  });

  it('returns the stored pref and the resolved default', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: null });
    const body = await (await GET(getReq())).json();
    expect(body.voiceId).toBeNull();
    expect(body.resolved).toBe(DEFAULT_VOICE_ID);
    expect(body.defaultVoiceId).toBe(DEFAULT_VOICE_ID);
  });
});

describe('PUT /api/aegis/voice', () => {
  it('401 when not logged in', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await PUT(putReq({ voiceId: DEFAULT_VOICE_ID }))).status).toBe(401);
  });

  it('persists a valid voice', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: null });
    update.mockResolvedValue({ voiceId: DEFAULT_VOICE_ID, voicePrefs: null });
    const res = await PUT(putReq({ voiceId: DEFAULT_VOICE_ID }));
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].where).toEqual({ id: 'u1' });
    expect(update.mock.calls[0][0].data).toEqual({ voiceId: DEFAULT_VOICE_ID });
  });

  it('stores null (= default) for an empty preference', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: 'cartesia:x' });
    update.mockResolvedValue({ voiceId: null, voicePrefs: null });
    const res = await PUT(putReq({ voiceId: null }));
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].data).toEqual({ voiceId: null });
  });

  it('rejects an unknown voice (400) and does not write', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: null });
    const res = await PUT(putReq({ voiceId: 'cartesia:not-real' }));
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('persists normalized prefs (clamps out-of-range values)', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: null });
    update.mockResolvedValue({ voiceId: null, voicePrefs: {} });
    const res = await PUT(putReq({ prefs: { rate: 9, volume: -1, autoRead: true, pushToTalk: true, vad: false } }));
    expect(res.status).toBe(200);
    const prefs = update.mock.calls[0][0].data.voicePrefs;
    expect(prefs.rate).toBe(2); // clamped 0.5–2
    expect(prefs.volume).toBe(0); // clamped 0–1
    expect(prefs.autoRead).toBe(true);
    expect(prefs.vad).toBe(false);
  });

  it('GET includes normalized prefs', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1', voiceId: null, voicePrefs: null });
    const body = await (await GET(getReq())).json();
    expect(body.prefs).toMatchObject({ rate: 1, volume: 1, autoRead: false, pushToTalk: false, vad: true });
  });
});
