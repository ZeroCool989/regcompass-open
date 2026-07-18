import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { checkImpl, authState, sessionState, exportImpl } = vi.hoisted(() => ({
  checkImpl: vi.fn(async () => ({ ok: true })),
  authState: { user: null as null | { id: string; status: string } },
  sessionState: { id: 'sess-1' as string | null },
  exportImpl: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ check: checkImpl }),
  ipHash: async () => 'iphash',
}));
vi.mock('@/lib/session', () => ({ readSessionId: () => sessionState.id }));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: async () => authState.user,
  isApproved: (u: { status?: string } | null) => u?.status === 'APPROVED',
}));
vi.mock('@/lib/aegis/export', () => ({
  exportAssessment: exportImpl,
  EXPORT_FORMATS: ['xlsx', 'docx', 'pdf'],
}));

import { POST } from '../export/route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/aegis/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CONV = '3b7c2c4e-8f4d-4e2a-9c1a-6d5e4f3a2b1c';

describe('POST /api/aegis/export', () => {
  it('401 for unauthenticated callers (German message)', async () => {
    authState.user = null;
    const res = await POST(req({ format: 'xlsx', conversationId: CONV }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toContain('Anmeldung');
    expect(exportImpl).not.toHaveBeenCalled();
  });

  it('400 for an invalid format', async () => {
    authState.user = { id: 'u1', status: 'APPROVED' };
    const res = await POST(req({ format: 'exe', conversationId: CONV }));
    expect(res.status).toBe(400);
  });

  it('delegates to the engine with session/user/conversation context', async () => {
    authState.user = { id: 'u1', status: 'APPROVED' };
    exportImpl.mockResolvedValueOnce({
      downloadId: 'd1',
      filename: 'AEGIS_Assessment_2026-07-17.xlsx',
      format: 'xlsx',
      sourceRef: { kind: 'conversation', conversationId: CONV, messageIds: [] },
      summary: { total: 3, gaps: 2, manualReview: 0, citedRequirements: 3, rejected: 0 },
    });
    const res = await POST(req({ format: 'xlsx', conversationId: CONV }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadId).toBe('d1');
    expect(exportImpl).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'xlsx' }),
      expect.objectContaining({ sessionId: 'sess-1', userId: 'u1', conversationId: CONV }),
    );
  });

  it('maps engine domain errors to a German 400', async () => {
    authState.user = { id: 'u1', status: 'APPROVED' };
    exportImpl.mockRejectedValueOnce(new Error('Keine Findings in dieser Unterhaltung gefunden.'));
    const res = await POST(req({ format: 'pdf', conversationId: CONV }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('Findings');
  });

  it('429 when rate-limited', async () => {
    authState.user = { id: 'u1', status: 'APPROVED' };
    checkImpl.mockResolvedValueOnce({ ok: false });
    const res = await POST(req({ format: 'xlsx', conversationId: CONV }));
    expect(res.status).toBe(429);
  });
});
