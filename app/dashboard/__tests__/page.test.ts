import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { getUserFromCookies, redirect } = vi.hoisted(() => ({
  getUserFromCookies: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/lib/auth', () => ({
  getUserFromCookies,
  isApproved: (u: { status?: string } | null) => !!u && u.status === 'APPROVED',
}));

import DashboardPage from '../page';

describe('/dashboard', () => {
  it('shows the tomorrow BYOK test checklist for admins', async () => {
    getUserFromCookies.mockResolvedValue({ id: 'admin-1', role: 'ADMIN', status: 'APPROVED' });

    const page = await DashboardPage();
    const html = renderToStaticMarkup(page);

    expect(html).toContain('Tomorrow BYOK Test TODO');
    expect(html).toContain('AEGIS_BYOK_ENCRYPTION_KEY');
    expect(html).toContain('/account/providers');
    expect(html).toContain('Anthropic BYOK');
  });
});
