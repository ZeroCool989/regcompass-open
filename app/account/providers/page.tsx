import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AiProviderSettings } from '@/components/AiProviderSettings';
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
        Hinterlegen Sie eigene Provider-Credentials (BYOK). Keys werden serverseitig verschlüsselt gespeichert und nie wieder angezeigt.
        Anthropic/Claude kann bereits für AEGIS aktiviert werden; OpenAI und Google sind vorbereitet, bleiben aber bis zur verifizierten Tool- und Zitier-Parität deaktiviert.
      </p>
      <AiProviderSettings />
    </div>
  );
}
