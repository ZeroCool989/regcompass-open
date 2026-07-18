import type { Metadata } from 'next';
import { VerifyEmailClient } from '@/components/VerifyEmailClient';

export const metadata: Metadata = {
  title: 'E-Mail bestätigen — RegCompass',
};

export default async function VerifyEmailPage({
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
        </div>
        <div className="rounded-2xl border border-border-brand bg-surface/50 p-6">
          <VerifyEmailClient token={token ?? null} />
        </div>
      </div>
    </div>
  );
}
