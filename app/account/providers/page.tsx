import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SubscriptionConnect } from '@/components/SubscriptionConnect';
import { getUserFromCookies } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Aegis AI-Provider — RegCompass' };

export default async function AiProvidersPage() {
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/account/providers');

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-heading font-bold">Aegis AI-Provider</h1>
        <Link href="/aegis" className="text-sm text-text-secondary hover:text-brand-primary transition-colors no-underline shrink-0">← AEGIS</Link>
      </div>
      <p className="text-sm text-text-secondary mb-8 max-w-2xl">
        Verbinden Sie Ihr ChatGPT-Abo, um AEGIS darüber zu betreiben. Die Anmeldung läuft
        lokal auf diesem Rechner — Ihre Zugangsdaten verlassen Ihren Rechner nicht.
      </p>
      <SubscriptionConnect />
    </div>
  );
}
