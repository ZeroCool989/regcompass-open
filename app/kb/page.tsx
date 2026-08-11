import { KB } from '@/lib/kb';
import { KBBrowser } from './KBBrowser';
import { KbVersionBanner } from './KbVersionBanner';
import { summarizeManifest } from '@/lib/kb/version';

export const metadata = {
  title: 'Wissensbasis | RegCompass',
  description:
    'Regulatorische Anforderungen für KI im Finanzsektor durchsuchen und filtern.',
};

export default function KBPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold font-heading mb-2">Wissensbasis</h1>
      <p className="text-text-secondary mb-8">
        {KB.requirements.length} Anforderungen aus {KB.regulations.length}{' '}
        Regulierungen
      </p>
      <KbVersionBanner local={summarizeManifest(KB.manifest)} />
      <KBBrowser
        requirements={KB.requirements}
        regulations={KB.regulations}
      />
    </main>
  );
}
