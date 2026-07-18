'use client';

import type { ActiveJob } from '@/lib/aegis/client-store';
import { SECTIONED_PAUSED_DE } from '@/lib/aegis/statusLabels';

/**
 * Sectioned-report progress (epic PR 3): the plan outline with per-section
 * state, rendered above the streaming text while an AegisJob runs. Calm by
 * design (iron rule): pauses show "Wird fortgesetzt …", degraded sections a
 * quiet amber marker — no internal event ever reads as an error here.
 */

function SectionIcon({ status }: { status: ActiveJob['sections'][number]['status'] }) {
  switch (status) {
    case 'done':
      return <span className="text-emerald-500" aria-label="fertig">✓</span>;
    case 'degraded':
      return (
        <span className="text-amber-500" aria-label="nicht vollständig verifiziert" title="Abschnitt nicht vollständig verifiziert">
          ⚠
        </span>
      );
    case 'writing':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent text-text-secondary align-middle" aria-label="wird geschrieben" />
      );
    default:
      return <span className="text-text-secondary/50" aria-label="ausstehend">○</span>;
  }
}

export default function ReportProgress({ job }: { job: ActiveJob }) {
  const done = job.sections.filter((s) => s.status === 'done' || s.status === 'degraded').length;
  const total = job.sections.length;
  return (
    <div className="rounded-lg border border-border-brand/40 bg-background/60 px-4 py-3 mb-4">
      <div className="flex items-center justify-between mb-2 text-[0.72rem] font-mono uppercase tracking-wider text-text-secondary">
        <span>Report — {done}/{total} Abschnitte</span>
        {job.phase === 'reconnecting' ? <span>{SECTIONED_PAUSED_DE}</span> : null}
      </div>
      <ol className="space-y-1">
        {job.sections.map((s) => (
          <li key={s.index} className="flex items-center gap-2 text-[0.85rem] text-foreground/90">
            <SectionIcon status={s.status} />
            <span className={s.status === 'pending' ? 'text-text-secondary/70' : ''}>{s.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
