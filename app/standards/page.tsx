import { KB } from '@/lib/kb';
import Link from 'next/link';

export const metadata = {
  title: 'Standards | RegCompass',
  description: 'Internationale Standards und Frameworks für KI-Governance.',
};

const STANDARD_IDS = ['ISO_42001', 'ISO_42005', 'ISO_23894', 'NIST_AI_RMF'] as const;

const NIST_FUNCTIONS = ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'] as const;
const NIST_COLORS: Record<string, string> = {
  GOVERN: 'bg-purple-600 text-white',
  MAP: 'bg-blue-600 text-white',
  MEASURE: 'bg-green-600 text-white',
  MANAGE: 'bg-orange-600 text-white',
};

export default function StandardsPage() {
  const standards = KB.regulations.filter((r) => (STANDARD_IDS as readonly string[]).includes(r.id));

  // Count controls by standard
  const controlsByStandard: Record<string, number> = {};
  const controlsByNistFunction: Record<string, number> = {};

  for (const req of KB.requirements) {
    for (const ctrl of req.controls) {
      if (ctrl.standard) {
        controlsByStandard[ctrl.standard] = (controlsByStandard[ctrl.standard] || 0) + 1;
      }
      if (ctrl.nistFunction) {
        controlsByNistFunction[ctrl.nistFunction] = (controlsByNistFunction[ctrl.nistFunction] || 0) + 1;
      }
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold font-heading mb-2">Standards &amp; Frameworks</h1>
      <p className="text-text-secondary mb-8">
        Internationale Standards und Frameworks, auf die RegCompass-Controls verweisen
      </p>

      {/* Standard Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        {standards.map((std) => (
          <div key={std.id} className="p-6 bg-surface border border-border-brand rounded-lg">
            <div className="flex items-start justify-between mb-3">
              <h2 className="text-lg font-bold font-heading">{std.shortName}</h2>
              <span className="px-2 py-0.5 text-xs bg-blue-500 text-white rounded">Best Practice</span>
            </div>
            <p className="text-sm text-text-secondary mb-4">{std.descriptionDe ?? std.description}</p>
            <div className="flex flex-wrap gap-3 text-sm">
              <div>
                <span className="text-text-secondary">Controls verknüpft: </span>
                <span className="font-bold text-brand-primary">{controlsByStandard[std.id] || 0}</span>
              </div>
              <div>
                <span className="text-text-secondary">Jurisdiktion: </span>
                <span className="px-1.5 py-0.5 text-xs border border-border-brand rounded">{std.jurisdiction}</span>
              </div>
              {std.effectiveDate && (
                <div>
                  <span className="text-text-secondary">Gültig ab: </span>
                  <span>{std.effectiveDate}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* NIST Functions */}
      <div className="mb-12">
        <h2 className="text-xl font-bold font-heading mb-4">NIST AI RMF Funktionen</h2>
        <p className="text-text-secondary text-sm mb-6">
          Controls, die den vier Kernfunktionen des NIST AI Risk Management Framework zugeordnet sind
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {NIST_FUNCTIONS.map((fn) => (
            <div key={fn} className="p-4 bg-surface border border-border-brand rounded-lg text-center">
              <span className={`inline-block px-3 py-1 text-sm font-bold rounded mb-2 ${NIST_COLORS[fn]}`}>
                {fn}
              </span>
              <p className="text-2xl font-bold text-foreground">{controlsByNistFunction[fn] || 0}</p>
              <p className="text-xs text-text-secondary">Controls</p>
            </div>
          ))}
        </div>
      </div>

      {/* Controls by Standard */}
      <div>
        <h2 className="text-xl font-bold font-heading mb-4">Alle Controls nach Standard</h2>
        {standards.map((std) => {
          const controls = KB.requirements.flatMap((req) =>
            req.controls
              .filter((c) => c.standard === std.id)
              .map((c) => ({ ...c, reqId: req.id, reqTitle: req.title }))
          );
          if (controls.length === 0) return null;
          return (
            <div key={std.id} className="mb-8">
              <h3 className="text-lg font-bold mb-3">{std.shortName}</h3>
              <div className="space-y-2">
                {controls.map((ctrl) => (
                  <Link
                    key={ctrl.id}
                    href={`/kb/${ctrl.reqId}`}
                    className="flex items-start gap-3 p-3 bg-surface border border-border-brand rounded-lg hover:border-brand-primary transition-colors"
                  >
                    <span className="shrink-0 px-2 py-0.5 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">
                      {ctrl.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{ctrl.actionDe ?? ctrl.action}</p>
                      <div className="flex gap-2 mt-1">
                        <span className="text-xs text-text-secondary">{ctrl.reqId}</span>
                        {ctrl.standardClause && (
                          <span className="text-xs text-brand-primary">{ctrl.standardClause}</span>
                        )}
                        {ctrl.nistFunction && (
                          <span className={`px-1.5 py-0.5 text-xs rounded ${NIST_COLORS[ctrl.nistFunction]}`}>
                            {ctrl.nistFunction}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
