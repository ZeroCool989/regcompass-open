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
  it('shows the regulatory dashboard for admins', async () => {
    getUserFromCookies.mockResolvedValue({ id: 'admin-1', role: 'ADMIN', status: 'APPROVED' });

    const page = await DashboardPage();
    const html = renderToStaticMarkup(page);

    expect(html).toContain('Regulatory Intelligence Dashboard');
    expect(html).toContain('Regulatorik');
    expect(html).not.toContain('Tomorrow BYOK Test TODO');
  });
});
