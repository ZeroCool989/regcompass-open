import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /history renders cross-user AEGIS usage telemetry (cost, tokens, model,
 * latency, exit reason) via the AegisUsageLog table. These tests prove the
 * admin gate runs BEFORE any telemetry query, so the data never reaches an
 * unauthenticated or non-admin caller (the leak the review found).
 *
 * `redirect` is mocked to throw, mirroring Next's real behaviour (it raises a
 * NEXT_REDIRECT signal to abort rendering) — so any code path that redirects
 * provably never reaches the `findMany` below it.
 */
const { getUserFromCookies, redirect, findMany } = vi.hoisted(() => ({
  getUserFromCookies: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  findMany: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/auth', () => ({
  getUserFromCookies,
  // Real semantics: approved iff status === 'APPROVED'.
  isApproved: (u: { status?: string } | null) => !!u && u.status === 'APPROVED',
}));
vi.mock('@/lib/db', () => ({ db: { aegisUsageLog: { findMany } } }));
// Stub the client components so importing the page doesn't pull their deps.
vi.mock('@/components/HistoryTable', () => ({ HistoryTable: () => null }));
vi.mock('@/components/ConversationHistory', () => ({ ConversationHistory: () => null }));

import HistoryPage from '../page';

describe('/history — usage telemetry is admin-only', () => {
  beforeEach(() => {
    getUserFromCookies.mockReset();
    redirect.mockClear();
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('redirects an unauthenticated visitor to /login and never queries telemetry', async () => {
    getUserFromCookies.mockResolvedValue(null);
    await expect(HistoryPage()).rejects.toThrow('REDIRECT:/login?next=/history');
    expect(redirect).toHaveBeenCalledWith('/login?next=/history');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('renders own-conversations view for a non-admin approved user — no telemetry query (F1)', async () => {
    getUserFromCookies.mockResolvedValue({ id: 'u1', role: 'USER', status: 'APPROVED' });
    await expect(HistoryPage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('allows an approved admin and loads telemetry exactly once', async () => {
    getUserFromCookies.mockResolvedValue({ id: 'a1', role: 'ADMIN', status: 'APPROVED' });
    await expect(HistoryPage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  // No telemetry query runs for ANY caller who isn't an approved admin — there
  // is no code path that delivers cross-user usage rows to a non-admin.
  // Approved non-admins now RENDER (their own conversations, F1) instead of
  // redirecting; everyone else still redirects. Either way: no findMany.
  it.each([
    ['unauthenticated', null, 'redirect'],
    ['approved non-admin', { id: 'u', role: 'USER', status: 'APPROVED' }, 'render'],
    ['pending non-admin', { id: 'u', role: 'USER', status: 'PENDING' }, 'redirect'],
    ['pending admin', { id: 'a', role: 'ADMIN', status: 'PENDING' }, 'redirect'],
    ['blocked admin', { id: 'a', role: 'ADMIN', status: 'BLOCKED' }, 'redirect'],
  ])('does not expose cross-user telemetry to %s', async (_label, user, outcome) => {
    getUserFromCookies.mockResolvedValue(user);
    if (outcome === 'redirect') {
      await expect(HistoryPage()).rejects.toThrow(/REDIRECT:/);
    } else {
      await expect(HistoryPage()).resolves.toBeTruthy();
    }
    expect(findMany).not.toHaveBeenCalled();
  });
});
