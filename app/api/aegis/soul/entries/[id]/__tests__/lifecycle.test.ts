import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUserFromRequest } = vi.hoisted(() => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getUserFromRequest }));

const { transitionEntry, revokeEntry } = vi.hoisted(() => ({
  transitionEntry: vi.fn(),
  revokeEntry: vi.fn(),
}));
vi.mock('@/lib/aegis/soul-store', () => ({ transitionEntry, revokeEntry }));

import { PATCH, DELETE } from '../route';

const params = (id = 'e1') => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown) =>
  new NextRequest('http://localhost/api/aegis/soul/entries/e1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const delReq = () =>
  new NextRequest('http://localhost/api/aegis/soul/entries/e1', { method: 'DELETE' });

afterEach(() => vi.clearAllMocks());

describe('soul entry lifecycle', () => {
  it('401 without a user (PATCH)', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await PATCH(patchReq({ action: 'confirm' }), params())).status).toBe(401);
  });

  it.each(['confirm', 'archive', 'restore'])('PATCH %s → transitionEntry', async (action) => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    transitionEntry.mockResolvedValue({ ok: true });
    const res = await PATCH(patchReq({ action }), params());
    expect(res.status).toBe(200);
    expect(transitionEntry).toHaveBeenCalledWith('u1', 'e1', action);
  });

  it('PATCH with invalid action → 400', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    const res = await PATCH(patchReq({ action: 'bogus' }), params());
    expect(res.status).toBe(400);
    expect(transitionEntry).not.toHaveBeenCalled();
  });

  it('DELETE removes the entry', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    revokeEntry.mockResolvedValue({ ok: true });
    const res = await DELETE(delReq(), params());
    expect(res.status).toBe(200);
    expect(revokeEntry).toHaveBeenCalledWith('u1', 'e1');
  });

  it('surfaces a not_found from the store', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    transitionEntry.mockResolvedValue({ ok: false, status: 404, error: 'not_found', message: 'x' });
    const res = await PATCH(patchReq({ action: 'archive' }), params());
    expect(res.status).toBe(404);
  });
});
