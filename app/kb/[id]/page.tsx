import { KB } from '@/lib/kb';
import {
  AUDIENCE_LABELS,
  BINDING_LEVEL_LABELS as BINDING_LABELS,
  CATEGORY_LABELS,
  COMPLEXITY_LABELS,
  PRIORITY_LABELS,
  RELEVANCE_LABELS,
  RISK_TIER_LABELS,
  label,
} from '@/lib/kb/labels';
import { notFound } from 'next/navigation';
import Link from 'next/link';

const BINDING_BADGES: Record<string, string> = {
  mandatory: 'bg-red-600 text-white',
  supervisory_expectation: 'bg-yellow-500 text-black',
  best_practice: 'bg-blue-500 text-white',
};

const RELEVANCE_COLORS: Record<string, string> = {
  critical: 'bg-risk-high text-white',
  high: 'bg-risk-limited text-black',
  medium: 'bg-brand-yellow text-black',
  low: 'bg-text-secondary/20 text-text-secondary',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-yellow-400',
  medium: 'text-blue-400',
  low: 'text-gray-400',
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const req = KB.byId(id);
  if (!req) return { title: 'Nicht gefunden | RegCompass' };
  return {
    title: `${req.id} — ${req.titleDe ?? req.title} | RegCompass`,
    description: req.summaryDe ?? req.summary,
  };
}

export default async function RequirementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const req = KB.byId(id);
  if (!req) notFound();

  const regulation = KB.regulations.find((r) => r.id === req.regulation);

  const sameRegulation = KB.requirements
    .filter((r) => r.regulation === req.regulation && r.id !== req.id)
    .slice(0, 5);
  const sameRegIds = new Set([req.id, ...sameRegulation.map((r) => r.id)]);
  const sameCategory = KB.requirements
    .filter((r) => r.category === req.category && !sameRegIds.has(r.id))
    .slice(0, 5);
  const hasRelated = sameRegulation.length > 0 || sameCategory.length > 0;

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      <Link
        href="/kb"
        className="inline-flex items-center text-sm text-text-secondary hover:text-brand-primary transition-colors mb-6"
      >
        &larr; Zurück zur Wissensbasis
      </Link>

      <div className="space-y-6">
        {/* Header */}
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <span className="px-2 py-1 text-sm font-mono bg-brand-primary/10 text-brand-primary rounded">
              {req.id}
            </span>
            <span className={`px-2 py-1 text-xs rounded ${BINDING_BADGES[req.bindingLevel] || ''}`}>
              {label(BINDING_LABELS, req.bindingLevel)}
            </span>
            {req.riskTier && (
              <span className="px-2 py-1 text-xs bg-surface border border-border-brand rounded">
                Risiko: {label(RISK_TIER_LABELS, req.riskTier)}
              </span>
            )}
            <span className={`px-2 py-1 text-xs rounded ${RELEVANCE_COLORS[req.relevanceForFinancialSector] || ''}`}>
              Relevanz: {label(RELEVANCE_LABELS, req.relevanceForFinancialSector)}
            </span>
            {req.verified ? (
              <span className="text-risk-minimal text-sm">&#10003; Verifiziert</span>
            ) : (
              <span className="text-risk-limited text-sm">&#9888; Noch nicht verifiziert</span>
            )}
          </div>
          <h1 className="text-3xl font-bold font-heading">{req.titleDe ?? req.title}</h1>
        </div>

        {/* Metadata */}
        <div className="flex flex-wrap gap-4 text-sm">
          <div>
            <span className="text-text-secondary">Regulierung: </span>
            <span className="font-medium">{regulation?.shortName || req.regulation}</span>
          </div>
          <div>
            <span className="text-text-secondary">Artikel: </span>
            <span className="font-medium">{req.article}</span>
          </div>
          <div>
            <span className="text-text-secondary">Jurisdiktion: </span>
            {req.jurisdiction.map((j) => (
              <span key={j} className="ml-1 px-1.5 py-0.5 text-xs border border-border-brand rounded">{j}</span>
            ))}
          </div>
          <div>
            <span className="text-text-secondary">Zielgruppe: </span>
            {req.audience.map((a) => (
              <span key={a} className="ml-1 px-1.5 py-0.5 text-xs border border-brand-primary/30 text-brand-primary rounded">
                {label(AUDIENCE_LABELS, a)}
              </span>
            ))}
          </div>
          <div>
            <span className="text-text-secondary">Kategorie: </span>
            <span className="ml-1 px-1.5 py-0.5 text-xs bg-brand-secondary/10 text-brand-secondary rounded">
              {label(CATEGORY_LABELS, req.category)}
            </span>
          </div>
        </div>

        {/* Enforcement */}
        <div className="p-3 bg-surface border border-border-brand rounded-lg text-sm">
          <span className="text-text-secondary">Durchsetzung: </span>
          <span>{req.enforcementConsequenceDe ?? req.enforcementConsequence}</span>
        </div>

        {/* Summary */}
        <div className="p-4 bg-surface border border-border-brand rounded-lg">
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary mb-2">Zusammenfassung</h2>
          <p>{req.summaryDe ?? req.summary}</p>
        </div>

        {/* Body */}
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary mb-2">Detaillierte Pflichten</h2>
          <div className="prose prose-invert max-w-none">
            <p className="text-sm leading-relaxed whitespace-pre-line">{req.bodyDe ?? req.body}</p>
          </div>
        </div>

        {/* Financial Sector Guidance */}
        {(req.financialSectorGuidanceDe ?? req.financialSectorGuidance) && (
          <div className="p-4 bg-brand-primary/5 border border-brand-primary/20 rounded-lg">
            <h2 className="text-sm font-bold uppercase tracking-wider text-brand-primary mb-2">Hinweise für den Finanzsektor</h2>
            <p className="text-sm leading-relaxed whitespace-pre-line">{req.financialSectorGuidanceDe ?? req.financialSectorGuidance}</p>
          </div>
        )}

        {/* Controls */}
        {req.controls.length > 0 && (
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary mb-4">
              Controls ({req.controls.length})
            </h2>
            <div className="space-y-4">
              {req.controls.map((ctrl) => (
                <details key={ctrl.id} className="group bg-surface border border-border-brand rounded-lg">
                  <summary className="flex items-start gap-3 p-4 cursor-pointer hover:bg-brand-primary/5 transition-colors">
                    <span className="shrink-0 px-2 py-0.5 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">
                      {ctrl.id}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{ctrl.actionDe ?? ctrl.action}</p>
                      <div className="flex gap-2 mt-1">
                        <span className={`text-xs ${PRIORITY_COLORS[ctrl.priority] || ''}`}>
                          {label(PRIORITY_LABELS, ctrl.priority)}
                        </span>
                        <span className="text-xs text-text-secondary">
                          {label(COMPLEXITY_LABELS, ctrl.complexity)}
                        </span>
                        {ctrl.standard && (
                          <span className="text-xs text-brand-primary">{ctrl.standard}</span>
                        )}
                        {ctrl.nistFunction && (
                          <span className="text-xs text-brand-secondary">{ctrl.nistFunction}</span>
                        )}
                      </div>
                    </div>
                  </summary>
                  <div className="px-4 pb-4 border-t border-border-brand pt-3">
                    <p className="text-sm text-text-secondary mb-3">{ctrl.descriptionDe ?? ctrl.description}</p>
                    {ctrl.standardClause && (
                      <p className="text-xs text-text-secondary mb-3">
                        Standard-Referenz: <span className="text-brand-primary">{ctrl.standardClause}</span>
                      </p>
                    )}
                    {(ctrl.implementationStepsDe ?? ctrl.implementationSteps).length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-text-secondary mb-2">Umsetzungsschritte</p>
                        <ol className="list-decimal list-inside space-y-1">
                          {(ctrl.implementationStepsDe ?? ctrl.implementationSteps).map((step, i) => (
                            <li key={i} className="text-sm text-text-secondary">{step}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {req.tags.length > 0 && (
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary mb-2">Tags</h2>
            <div className="flex flex-wrap gap-2">
              {req.tags.map((tag) => (
                <span key={tag} className="px-2 py-1 text-xs bg-brand-primary/10 text-brand-primary rounded-full">{tag}</span>
              ))}
            </div>
          </div>
        )}

        {/* Source */}
        {req.sourceFile && (
          <div className="pt-4 border-t border-border-brand">
            <span className="text-sm text-text-secondary">Quelle: </span>
            <span className="text-sm font-mono">docs/source/{req.sourceFile}</span>
          </div>
        )}

        {req.verified && req.verifiedBy && (
          <div className="text-sm text-text-secondary">
            Verifiziert von {req.verifiedBy}
            {req.verifiedAt && ` am ${req.verifiedAt}`}
          </div>
        )}

        {/* Related Requirements */}
        {hasRelated && (
          <div className="pt-6 border-t border-border-brand">
            <h2 className="text-sm font-bold uppercase tracking-wider text-text-secondary mb-4">Verwandte Anforderungen</h2>
            <div className="grid gap-3">
              {sameRegulation.length > 0 && (
                <div>
                  <p className="text-xs text-text-secondary mb-2">Gleiche Regulierung ({regulation?.shortName || req.regulation})</p>
                  <div className="grid gap-2">
                    {sameRegulation.map((r) => (
                      <Link key={r.id} href={`/kb/${r.id}`} className="flex items-center gap-3 p-3 bg-surface border border-border-brand rounded-lg hover:border-brand-primary transition-colors">
                        <span className="shrink-0 px-2 py-0.5 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">{r.id}</span>
                        <span className="text-sm truncate">{r.titleDe ?? r.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {sameCategory.length > 0 && (
                <div className={sameRegulation.length > 0 ? 'mt-3' : ''}>
                  <p className="text-xs text-text-secondary mb-2">Gleiche Kategorie ({label(CATEGORY_LABELS, req.category)})</p>
                  <div className="grid gap-2">
                    {sameCategory.map((r) => (
                      <Link key={r.id} href={`/kb/${r.id}`} className="flex items-center gap-3 p-3 bg-surface border border-border-brand rounded-lg hover:border-brand-primary transition-colors">
                        <span className="shrink-0 px-2 py-0.5 text-xs font-mono bg-brand-primary/10 text-brand-primary rounded">{r.id}</span>
                        <span className="text-sm truncate">{r.titleDe ?? r.title}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
