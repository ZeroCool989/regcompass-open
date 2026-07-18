import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/components/ResetPasswordForm';

export const metadata: Metadata = {
  title: 'Neues Passwort — RegCompass',
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-2xl font-heading font-bold tracking-tight">RegCompass</div>
          <p className="text-sm text-text-secondary mt-1">Neues Passwort setzen</p>
        </div>
        <div className="rounded-2xl border border-border-brand bg-surface/50 p-6">
          <ResetPasswordForm token={token ?? ''} />
        </div>
      </div>
    </div>
  );
}
