import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SoulManager } from '@/components/SoulManager';
import { getUserFromCookies } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Personalisierung — RegCompass',
};

export default async function SoulPage() {
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/account/soul');

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-heading font-bold">Personalisierung</h1>
        <Link
          href="/aegis"
          className="text-sm text-text-secondary hover:text-brand-primary transition-colors no-underline shrink-0"
        >
          ← AEGIS
        </Link>
      </div>
      <p className="text-sm text-text-secondary mb-8 max-w-2xl">
        Steuern Sie, <em>wie</em> AEGIS mit Ihnen kommuniziert — Stil, Struktur und
        Priorisierung. Diese Präferenzen beeinflussen niemals regulatorische Inhalte,
        Quellen oder die Verifikation. Es werden ausschliesslich Stil-Präferenzen
        gespeichert, niemals geschäftliche oder regulatorische Daten.
      </p>
      <SoulManager />
    </div>
  );
}
