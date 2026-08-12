import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable Prisma user model for the implicit-local-user seed/backfill.
const { mockUpsert, mockUpdateMany } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockUpdateMany: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: { user: { upsert: mockUpsert, updateMany: mockUpdateMany } },
}));

import { ensureLocalUser, LOCAL_USER_ID } from '@/lib/auth';

beforeEach(() => {
  mockUpsert.mockReset();
  mockUpdateMany.mockReset();
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('ensureLocalUser — implicit local user is seeded with an explicit Anthropic selection', () => {
  it('creates a NEW local user with a stored aegisProvider = anthropic-api', async () => {
    // A freshly-created row already carries the default from the create branch.
    mockUpsert.mockResolvedValue({ id: LOCAL_USER_ID, aegisProvider: 'anthropic-api' });
    const user = await ensureLocalUser();
    expect(user.aegisProvider).toBe('anthropic-api');
    // The stored default is set at creation (not a runtime fallback).
    expect(mockUpsert.mock.calls[0][0].create).toMatchObject({ aegisProvider: 'anthropic-api' });
    // Nothing to backfill for a fresh row.
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('backfills an EXISTING local user whose selection is still null (once, guarded)', async () => {
    mockUpsert.mockResolvedValue({ id: LOCAL_USER_ID, aegisProvider: null });
    const user = await ensureLocalUser();
    expect(user.aegisProvider).toBe('anthropic-api');
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    // Guarded on id + null → never touches a non-local user, never overwrites a pick.
    expect(mockUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: LOCAL_USER_ID, aegisProvider: null },
      data: { aegisProvider: 'anthropic-api' },
    });
  });

  it('does NOT overwrite an existing explicit Gemini/ChatGPT selection', async () => {
    for (const picked of ['gemini-api', 'chatgpt-codex']) {
      mockUpsert.mockResolvedValue({ id: LOCAL_USER_ID, aegisProvider: picked });
      const user = await ensureLocalUser();
      expect(user.aegisProvider).toBe(picked);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    }
  });

  it('is idempotent: a repeated call on an already-seeded user rewrites nothing', async () => {
    mockUpsert.mockResolvedValue({ id: LOCAL_USER_ID, aegisProvider: 'anthropic-api' });
    await ensureLocalUser();
    await ensureLocalUser();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
