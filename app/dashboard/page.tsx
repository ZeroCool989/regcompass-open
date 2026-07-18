import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import fs from 'node:fs';
import path from 'node:path';
import { getUserFromCookies, isApproved } from '@/lib/auth';
import { KB } from '@/lib/kb';
import {
  RegulationMatrix,
  type RegRow,
} from '@/components/dashboard/RegulationMatrix';
import { AegisUsageKpis } from '@/components/dashboard/AegisUsageKpis';
import { AegisUsagePanel } from '@/components/dashboard/AegisUsagePanel';
import { DashboardTabs } from '@/components/dashboard/DashboardTabs';

export const metadata: Metadata = {
  title: 'Dashboard — RegCompass',
  description:
    'KB-Coverage, Controls Health und AEGIS-Usage in Echtzeit — eine Karte für die regulatorische Lage.',
};

// Render at request time so KB-age and source-file counts stay current
// without a redeploy. The KB itself is shipped statically so this is cheap.
export const dynamic = 'force-dynamic';

// ───────────────────────── Color tokens ─────────────────────────

const JUR_COLORS: Record<string, string> = {
  EU: '#00BFFF',
  CH: '#f44336',
  DE: '#e8e44a',
  INTL: '#7b8cde',
};

const BINDING_COLORS: Record<string, string> = {
  mandatory: '#f44336',
  supervisory_expectation: '#ffc107',
  best_practice: '#00BFFF',
};

const COVERAGE_GREEN = '#4caf50';
const COVERAGE_YELLOW = '#ffc107';
const COVERAGE_RED = '#f44336';

function coverageColor(p: number): string {
  if (p >= 100) return COVERAGE_GREEN;
  if (p >= 50) return COVERAGE_YELLOW;
  return COVERAGE_RED;
}

// ───────────────────────── Helpers ─────────────────────────

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

// ───────────────────────── Page ─────────────────────────

export default async function DashboardPage() {
  // Usage/cost telemetry is admin-only; bounce everyone else (no info leak).
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/dashboard');
  if (user.role !== 'ADMIN' || !isApproved(user)) redirect('/aegis');

  // KPIs from KB ----------------------------------------------------------------
  const totalRegs = KB.regulations.length;
  const totalReqs = KB.requirements.length;
  const reqsWithCtrl = KB.requirements.filter((r) => r.controls.length > 0).length;
  const reqsWithoutCtrl = totalReqs - reqsWithCtrl;
  const totalCrosswalk = KB.crosswalk.length;

  // Coverage matrix data -------------------------------------------------------
  const regRows: RegRow[] = KB.regulations.map((r) => {
    const reqs = KB.requirements.filter((q) => q.regulation === r.id);
    const withCtrl = reqs.filter((q) => q.controls.length > 0).length;
    return {
      id: r.id,
      shortName: r.shortName,
      // Prefer the German name if available; falls back to the source name.
      name: r.nameDe ?? r.name,
      jurisdiction: r.jurisdiction,
      bindingLevel: r.bindingLevel,
      reqCount: reqs.length,
      controlCount: withCtrl,
      gapCount: reqs.length - withCtrl,
      coveragePct: pct(withCtrl, reqs.length),
    };
  });

  // Jurisdiction distribution --------------------------------------------------
  const jurOrder = ['EU', 'CH', 'DE', 'INTL'] as const;
  const jurCounts = jurOrder.map((jur) => ({
    label: jur,
    count: KB.requirements.filter((r) =>
      (r.jurisdiction as readonly string[]).includes(jur),
    ).length,
    color: JUR_COLORS[jur],
  }));
  const jurTotal = jurCounts.reduce((s, x) => s + x.count, 0);

  // Binding level distribution -------------------------------------------------
  const bindingOrder = [
    'mandatory',
    'supervisory_expectation',
    'best_practice',
  ] as const;
  const bindingLabels: Record<string, string> = {
    mandatory: 'Verpflichtend',
    supervisory_expectation: 'Aufsichtsrechtlich',
    best_practice: 'Best Practice',
  };
  const bindingCounts = bindingOrder.map((b) => ({
    key: b,
    label: bindingLabels[b],
    count: KB.requirements.filter((r) => r.bindingLevel === b).length,
    color: BINDING_COLORS[b],
  }));
  const bindingMax = Math.max(...bindingCounts.map((b) => b.count), 1);

  // Top categories WITHOUT controls --------------------------------------------
  const catMap = new Map<string, number>();
  for (const r of KB.requirements.filter((q) => q.controls.length === 0)) {
    catMap.set(r.category, (catMap.get(r.category) ?? 0) + 1);
  }
  const topGaps = Array.from(catMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  const topGapsMax = topGaps[0]?.count ?? 1;

  // KB Freshness ----------------------------------------------------------------
  const today = new Date();
  const kbDate = new Date(KB.version);
  const kbAgeDays = daysBetween(kbDate, today);
  const isStale = kbAgeDays > 30;
  const latestVerified =
    KB.requirements
      .map((r) => r.verifiedAt)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? '—';
  const verifiedCount = KB.requirements.filter((r) => r.verified).length;
  let sourceFileCount = 0;
  try {
    sourceFileCount = fs
      .readdirSync(path.join(process.cwd(), 'docs/source'))
      .filter((f) => f.endsWith('.txt')).length;
  } catch {
    /* directory missing → 0 */
  }
  const todayIso = today.toISOString().slice(0, 10);
  const byokTodoItems = [
    'Set AEGIS_BYOK_ENCRYPTION_KEY and confirm ANTHROPIC_API_KEY fallback exists.',
    'Run corepack pnpm db:push on this branch.',
    'Open /account/providers and save an Anthropic BYOK credential.',
    'Run AEGIS with Anthropic BYOK, then remove the key and verify fallback.',
    'Test a long prompt and confirm graceful validation/degrade instead of crash.',
  ];

  const regulatoryView = (
    <div className="space-y-10 mt-8">
      {/* KB headline KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Regulationen" value={totalRegs} hint="Gesetze in der KB" />
        <KpiCard
          label="Anforderungen"
          value={totalReqs}
          hint="Verifizierte Einträge"
          accent="primary"
        />
        <KpiCard
          label="Mit Controls"
          value={reqsWithCtrl}
          hint={`${pct(reqsWithCtrl, totalReqs)}% Abdeckung`}
          accent="success"
        />
        <KpiCard
          label="Controls-Lücke"
          value={reqsWithoutCtrl}
          hint="Anf. ohne Controls"
          accent={reqsWithoutCtrl > 0 ? 'warning' : 'success'}
        />
        <KpiCard label="Crosswalk" value={totalCrosswalk} hint="Mappings" />
      </section>

      {/* Regulation Coverage Matrix */}
      <section>
          <SectionHeader
            title="Regulation Coverage Matrix"
            subtitle="Sortierbare Übersicht aller Regulationen — Klick auf eine Zeile öffnet die KB"
          />
          <RegulationMatrix rows={regRows} />
        </section>

        {/* ──────────────── S3: Distribution Charts ──────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel
            title="Jurisdiktion"
            subtitle={`${jurTotal} Anforderungs-Vorkommen über 4 Rechtsräume`}
          >
            <div className="flex items-center gap-6">
              <Donut total={jurTotal} segments={jurCounts} size={180} />
              <ul className="flex-1 space-y-2 text-sm">
                {jurCounts.map((j) => (
                  <li key={j.label} className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-sm shrink-0"
                      style={{ background: j.color }}
                    />
                    <span className="font-semibold w-12">{j.label}</span>
                    <span className="text-text-secondary flex-1">
                      {pct(j.count, jurTotal)}%
                    </span>
                    <span className="font-mono">{j.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>

          <Panel title="Binding Level" subtitle="Pflichtgrad der Anforderungen">
            <ul className="space-y-3.5 pt-1">
              {bindingCounts.map((b) => (
                <li key={b.key} className="flex items-center gap-3">
                  <span className="w-32 text-sm shrink-0">{b.label}</span>
                  <div className="flex-1 h-5 rounded bg-surface/80 overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${(b.count / bindingMax) * 100}%`,
                        background: b.color,
                      }}
                    />
                  </div>
                  <span className="w-10 text-sm font-mono text-right">{b.count}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>

        {/* ──────────────── S4: Controls Health ──────────────── */}
        <section>
          <SectionHeader
            title="Controls Health"
            subtitle="Welche Regulationen sind stark abgedeckt — und wo klaffen Lücken?"
          />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 rounded-xl border border-border-brand bg-surface/50 p-5">
              <div className="text-xs font-mono uppercase tracking-wider text-text-secondary/80 mb-3">
                Heatmap (Controls-Coverage je Regulation)
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-7 gap-2">
                {regRows.map((r) => (
                  <div
                    key={r.id}
                    title={`${r.name} — ${r.coveragePct}% (${r.controlCount}/${r.reqCount})`}
                    className="aspect-square rounded-md p-1.5 flex flex-col justify-between text-[0.7rem] font-mono"
                    style={{
                      background: `${coverageColor(r.coveragePct)}26`,
                      borderLeft: `3px solid ${coverageColor(r.coveragePct)}`,
                    }}
                  >
                    <span className="text-foreground/90 truncate">
                      {r.shortName}
                    </span>
                    <span className="text-foreground font-semibold text-sm">
                      {r.coveragePct}%
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-text-secondary">
                <LegendDot color={COVERAGE_RED} label="< 50%" />
                <LegendDot color={COVERAGE_YELLOW} label="50–99%" />
                <LegendDot color={COVERAGE_GREEN} label="100%" />
              </div>
            </div>

            <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
              <div className="text-xs font-mono uppercase tracking-wider text-text-secondary/80 mb-3">
                Top 5: Kategorien ohne Controls
              </div>
              {topGaps.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  Alle Kategorien haben mindestens einen Control-Eintrag.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {topGaps.map((g, i) => (
                    <li key={g.category} className="flex items-center gap-3">
                      <span className="w-5 text-xs font-mono text-text-secondary text-right">
                        {i + 1}.
                      </span>
                      <span className="flex-1 text-sm font-mono truncate">
                        {g.category}
                      </span>
                      <div className="w-20 h-2 rounded bg-surface/80 overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${(g.count / topGapsMax) * 100}%`,
                            background: COVERAGE_RED,
                            opacity: 0.7,
                          }}
                        />
                      </div>
                      <span className="w-10 text-xs font-mono text-right">
                        {g.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* KB Freshness */}
        <section>
          <SectionHeader
            title="KB Freshness"
            subtitle="Aktualität der Wissensbasis"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile
              label="KB-Version"
              value={KB.version}
              note={`vor ${kbAgeDays} Tag${kbAgeDays === 1 ? '' : 'en'}`}
              accent={isStale ? 'warning' : 'success'}
            />
            <Tile
              label="Letzte Verifikation"
              value={latestVerified}
              note="neuestes verifiedAt"
            />
            <Tile
              label="Quelldateien"
              value={sourceFileCount.toString()}
              note="docs/source/*.txt"
            />
            <Tile
              label="Verifiziert"
              value={`${verifiedCount}/${totalReqs}`}
              note={`${pct(verifiedCount, totalReqs)}% Anforderungen`}
              accent={verifiedCount === totalReqs ? 'success' : 'warning'}
            />
          </div>
          {isStale ? (
            <div className="mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
              ⚠️ KB-Version ist {kbAgeDays} Tage alt. Quellen prüfen und ggf.
              neue Verifikationsrunde anstoßen.
            </div>
          ) : null}
        </section>
    </div>
  );

  const costView = (
    <div className="space-y-10 mt-8">
      {/* AEGIS KPIs (4 cards) */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <AegisUsageKpis />
      </section>

      {/* AEGIS Usage Panel — verify-rate, daily bars, models, modes, recent calls */}
      <section>
        <SectionHeader
          title="AEGIS Usage"
          subtitle="Anfragen, Kosten und Qualität des Compliance-Beraters (letzte 7 Tage)"
        />
        <AegisUsagePanel />
      </section>
    </div>
  );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <header className="mb-6">
          <div className="inline-block px-2.5 py-0.5 text-[0.65rem] font-mono uppercase tracking-wider bg-brand-primary/15 text-brand-primary rounded border border-brand-primary/30 mb-2">
            Live · {todayIso}
          </div>
          <h1 className="text-3xl md:text-4xl font-bold font-heading tracking-tight">
            Regulatory Intelligence Dashboard
          </h1>
          <p className="text-text-secondary mt-1">
            KB-Coverage · Controls Health · AEGIS-Usage — eine Karte für die
            regulatorische Lage.
          </p>
        </header>

        <section className="mb-8 rounded-2xl border border-brand-primary/30 bg-brand-primary/10 p-5 shadow-[0_0_40px_rgba(0,191,255,0.06)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[0.65rem] font-mono uppercase tracking-wider text-brand-primary mb-2">
                Feature branch · Testing tomorrow
              </div>
              <h2 className="text-xl md:text-2xl font-bold font-heading">
                Tomorrow BYOK Test TODO
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-text-secondary">
                Checklist for validating AEGIS provider credentials, fallback behaviour,
                and long-prompt robustness before opening the PR.
              </p>
            </div>
            <a
              href="/account/providers"
              className="inline-flex items-center justify-center rounded-lg border border-brand-primary/40 bg-brand-primary/15 px-4 py-2 text-sm font-semibold text-brand-primary transition-colors hover:bg-brand-primary/25"
            >
              Open provider settings
            </a>
          </div>
          <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {byokTodoItems.map((item, index) => (
              <li
                key={item}
                className="rounded-xl border border-border-brand bg-background/45 p-4 text-sm text-foreground"
              >
                <div className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-primary/20 font-mono text-xs font-bold text-brand-primary">
                  {index + 1}
                </div>
                <div>{item}</div>
              </li>
            ))}
          </ol>
          <div className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
            OpenAI/Gemini are foundation/status only for this branch. Treat Anthropic BYOK
            as the real runtime path for tomorrow’s test.
          </div>
        </section>

        <DashboardTabs regulatory={regulatoryView} cost={costView} />
      </div>
    </main>
  );
}

// ───────────────────────── Subcomponents (server) ─────────────────────────

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-xl md:text-2xl font-bold font-heading">{title}</h2>
      <p className="text-sm text-text-secondary mt-0.5">{subtitle}</p>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border-brand bg-surface/50 p-5">
      <div className="mb-4">
        <h3 className="text-base font-semibold font-heading">{title}</h3>
        {subtitle ? (
          <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

type Accent = 'primary' | 'success' | 'warning' | 'neutral';

function accentColor(accent: Accent | undefined): string {
  switch (accent) {
    case 'primary':
      return 'text-brand-primary';
    case 'success':
      return 'text-emerald-400';
    case 'warning':
      return 'text-orange-400';
    default:
      return 'text-foreground';
  }
}

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: Accent;
}) {
  return (
    <div className="rounded-xl border border-border-brand bg-surface/50 p-4">
      <div className={`text-3xl font-bold font-heading ${accentColor(accent)}`}>
        {value}
      </div>
      <div className="mt-0.5 text-sm font-semibold">{label}</div>
      {hint ? (
        <div className="mt-0.5 text-[0.7rem] text-text-secondary">{hint}</div>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: Accent;
}) {
  return (
    <div className="rounded-xl border border-border-brand bg-surface/50 p-4">
      <div className="text-[0.7rem] font-mono uppercase tracking-wider text-text-secondary/80">
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-semibold font-heading ${accentColor(accent)}`}
      >
        {value}
      </div>
      {note ? (
        <div className="mt-0.5 text-xs text-text-secondary">{note}</div>
      ) : null}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </span>
  );
}

// Inline SVG donut — pure presentational, server-rendered.
function Donut({
  total,
  segments,
  size = 160,
}: {
  total: number;
  segments: Array<{ label: string; count: number; color: string }>;
  size?: number;
}) {
  if (total === 0) {
    return (
      <div
        className="rounded-full border border-dashed border-border-brand text-text-secondary text-xs flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        Keine Daten
      </div>
    );
  }
  let acc = 0;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="shrink-0 text-foreground"
      aria-hidden="true"
    >
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="14"
      />
      {segments.map((seg) => {
        const p = (seg.count / total) * 100;
        const dashOffset = -acc;
        const el = (
          <circle
            key={seg.label}
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke={seg.color}
            strokeWidth="14"
            pathLength={100}
            strokeDasharray={`${p} 100`}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 50 50)"
          />
        );
        acc += p;
        return el;
      })}
      <text
        x="50"
        y="49"
        textAnchor="middle"
        fill="currentColor"
        style={{ fontSize: 12, fontWeight: 700 }}
      >
        {total}
      </text>
      <text
        x="50"
        y="61"
        textAnchor="middle"
        fill="currentColor"
        style={{ fontSize: 6 }}
        opacity={0.55}
      >
        gesamt
      </text>
    </svg>
  );
}
