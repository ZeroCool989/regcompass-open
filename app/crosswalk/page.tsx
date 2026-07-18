import { KB } from '@/lib/kb';
import Link from 'next/link';

export const metadata = {
  title: 'Querverweise | RegCompass',
  description:
    'Querverweise zwischen Regulierungen — überlappende Pflichten themenweise gebündelt.',
};

const REG_COLORS: Record<string, string> = {
  EU_AI_ACT: 'bg-blue-600',
  DORA: 'bg-indigo-600',
  GDPR: 'bg-green-600',
  NIS2: 'bg-teal-600',
  DSA: 'bg-cyan-600',
  DATA_ACT: 'bg-sky-600',
  PRODUCT_LIABILITY: 'bg-violet-600',
  FINMA_08_2024: 'bg-red-600',
  FINMA_RS_2023_1: 'bg-red-500',
  FINMA_RS_2018_3: 'bg-red-400',
  REVDSG: 'bg-orange-600',
  BDSG: 'bg-yellow-600',
  BSIG: 'bg-amber-600',
  MARISK: 'bg-lime-600',
  BAIT: 'bg-emerald-600',
  ISO_42001: 'bg-purple-600',
  ISO_42005: 'bg-purple-500',
  ISO_23894: 'bg-purple-400',
  NIST_AI_RMF: 'bg-fuchsia-600',
};

export default function CrosswalkPage() {
  const regMeta = new Map(KB.regulations.map((r) => [r.id, r]));

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold font-heading mb-2">Querverweise</h1>
      <p className="text-text-secondary mb-8">
        {KB.crosswalk.length} Themen, die überlappende Pflichten aus{' '}
        {KB.regulations.length} Regulierungen verknüpfen
      </p>

      <div className="space-y-6">
        {KB.crosswalk.map((entry) => {
          const reqs = entry.requirements
            .map((id) => KB.byId(id))
            .filter(Boolean);

          return (
            <div key={entry.id} className="p-6 bg-surface border border-border-brand rounded-lg">
              <div className="flex items-start gap-3 mb-3">
                <span className="shrink-0 px-2 py-1 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">
                  {entry.id}
                </span>
                <h2 className="text-lg font-bold font-heading">{entry.topicDe ?? entry.topic}</h2>
              </div>

              <p className="text-sm text-text-secondary mb-4">{entry.descriptionDe ?? entry.description}</p>

              {/* Regulation dots */}
              <div className="flex flex-wrap gap-1 mb-4">
                {reqs.map((req) => {
                  if (!req) return null;
                  const meta = regMeta.get(req.regulation);
                  return (
                    <span
                      key={req.id}
                      className={`w-3 h-3 rounded-full ${REG_COLORS[req.regulation] || 'bg-gray-500'}`}
                      title={meta?.shortName || req.regulation}
                    />
                  );
                })}
              </div>

              {/* Requirements */}
              <div className="mb-4">
                <p className="text-xs font-bold uppercase tracking-wider text-text-secondary mb-2">
                  Anforderungen ({entry.requirements.length})
                </p>
                <div className="flex flex-wrap gap-2">
                  {entry.requirements.map((reqId) => {
                    const req = KB.byId(reqId);
                    return (
                      <Link
                        key={reqId}
                        href={`/kb/${reqId}`}
                        className="inline-flex items-center gap-1.5 px-2 py-1 text-xs bg-surface border border-border-brand rounded hover:border-brand-primary transition-colors"
                        title={req?.titleDe ?? req?.title}
                      >
                        <span className={`w-2 h-2 rounded-full ${req ? (REG_COLORS[req.regulation] || 'bg-gray-500') : 'bg-gray-500'}`} />
                        <span className="font-mono text-brand-primary">{reqId}</span>
                        {req && (
                          <span className="text-text-secondary max-w-[150px] truncate">{regMeta.get(req.regulation)?.shortName}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>

              {/* Standards */}
              {entry.standards.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-text-secondary mb-2">
                    Standard-Referenzen
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {entry.standards.map((std) => (
                      <span
                        key={std}
                        className="px-2 py-1 text-xs bg-purple-600/10 text-purple-400 border border-purple-600/20 rounded"
                      >
                        {std}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
