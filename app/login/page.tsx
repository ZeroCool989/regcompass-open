import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Compass3D from '@/components/Compass3D';
import { LoginForm } from '@/components/LoginForm';
import { getUserFromCookies, isApproved } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Anmelden — RegCompass',
};

// Only allow internal redirect targets to avoid open-redirect via ?next=.
function safeNext(raw: string | undefined): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/aegis';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  // Already signed in and approved → no reason to show the login form.
  const user = await getUserFromCookies();
  if (isApproved(user)) redirect(target);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-4">
          <Compass3D className="w-64 h-64 md:w-80 md:h-80" />
        </div>
        <div className="text-center mb-8">
          <div className="text-2xl font-heading font-bold tracking-tight">RegCompass</div>
          <p className="text-sm text-text-secondary mt-1">
            Anmelden, um AEGIS zu nutzen
          </p>
        </div>
        <div className="rounded-2xl border border-border-brand bg-surface/50 p-6">
          <LoginForm next={target} />
        </div>
      </div>
    </div>
  );
}
