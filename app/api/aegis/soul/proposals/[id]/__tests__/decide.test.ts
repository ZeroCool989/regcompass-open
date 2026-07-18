import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getUserFromRequest } = vi.hoisted(() => ({ getUserFromRequest: vi.fn() }));
vi.mock('@/lib/auth', () => ({ getUserFromRequest }));

const { acceptProposal, rejectProposal } = vi.hoisted(() => ({
  acceptProposal: vi.fn(),
  rejectProposal: vi.fn(),
}));
vi.mock('@/lib/aegis/soul-store', () => ({ acceptProposal, rejectProposal }));

import { POST } from '../route';

const params = (id = 'p1') => ({ params: Promise.resolve({ id }) });
function req(body: unknown) {
  return new NextRequest('http://localhost/api/aegis/soul/proposals/p1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.clearAllMocks());

describe('POST /api/aegis/soul/proposals/[id]', () => {
  it('401 when not logged in', async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await POST(req({ action: 'accept' }), params());
    expect(res.status).toBe(401);
  });

  it('accepts a proposal', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    acceptProposal.mockResolvedValue({ ok: true });
    const res = await POST(req({ action: 'accept' }), params());
    expect(res.status).toBe(200);
    expect(acceptProposal).toHaveBeenCalledWith('u1', 'p1', undefined, undefined);
  });

  it('edit passes the edited content through (re-firewalled in the store)', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    acceptProposal.mockResolvedValue({ ok: true });
    const res = await POST(req({ action: 'edit', content: 'Knapper bitte.' }), params());
    expect(res.status).toBe(200);
    expect(acceptProposal).toHaveBeenCalledWith('u1', 'p1', 'Knapper bitte.', undefined);
  });

  it('edit requires content', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    const res = await POST(req({ action: 'edit' }), params());
    expect(res.status).toBe(400);
    expect(acceptProposal).not.toHaveBeenCalled();
  });

  it('surfaces a firewall block from the store as 400', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    acceptProposal.mockResolvedValue({
      ok: false, status: 400, error: 'firewall_blocked', message: 'blocked',
    });
    const res = await POST(req({ action: 'edit', content: 'DSGVO Pflicht' }), params());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('firewall_blocked');
  });

  it('rejects a proposal', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    rejectProposal.mockResolvedValue({ ok: true });
    const res = await POST(req({ action: 'reject' }), params());
    expect(res.status).toBe(200);
    expect(rejectProposal).toHaveBeenCalledWith('u1', 'p1');
  });

  it('400 on an invalid action', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    const res = await POST(req({ action: 'bogus' }), params());
    expect(res.status).toBe(400);
  });

  it('surfaces a 409 contradiction with the conflicting entry', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    acceptProposal.mockResolvedValue({
      ok: false, status: 409, error: 'contradiction', message: 'Widerspruch',
      conflict: { id: 'old', content: 'Bevorzugt knappe Antworten.', axis: 'Länge' },
    });
    const res = await POST(req({ action: 'accept' }), params());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('contradiction');
    expect(body.conflict.id).toBe('old');
  });

  it('resolves "new wins" by passing archiveConflictId through', async () => {
    getUserFromRequest.mockResolvedValue({ id: 'u1' });
    acceptProposal.mockResolvedValue({ ok: true });
    const res = await POST(req({ action: 'accept', archiveConflictId: 'old' }), params());
    expect(res.status).toBe(200);
    expect(acceptProposal).toHaveBeenCalledWith('u1', 'p1', undefined, 'old');
  });
});
