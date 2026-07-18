import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { VoiceSettings } from '@/components/VoiceSettings';
import { getUserFromCookies } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Aegis-Stimme — RegCompass' };

export default async function VoicePage() {
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/account/voice');

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-heading font-bold">Aegis-Stimme</h1>
        <Link
          href="/aegis"
          className="text-sm text-text-secondary hover:text-brand-primary transition-colors no-underline shrink-0"
        >
          ← AEGIS
        </Link>
      </div>
      <p className="text-sm text-text-secondary mb-8 max-w-xl">
        Wählen Sie, mit welcher Stimme AEGIS Ihre Antworten vorliest. Hören Sie
        eine Stimme mit „Vorhören&quot; probe. Die KI-Stimmen sind deutschsprachig;
        alternativ kann die Gerätestimme Ihres Browsers verwendet werden.
      </p>
      <VoiceSettings />
    </div>
  );
}
