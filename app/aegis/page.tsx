import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AegisChatPanel } from '@/components/AegisChatPanel';
import { AegisLogoutButton } from '@/components/AegisLogoutButton';
import { getUserFromCookies, isApproved, requireAdmin } from '@/lib/auth';
import { KB } from '@/lib/kb';

const TOTAL_REQS = KB.stats.totalRequirements;
const TOTAL_REGS = KB.regulations.length;

export const metadata: Metadata = {
  title: 'AEGIS — Der KI-Regulatorik-Berater von RegCompass',
  description: `AEGIS ist der AI-Agent von RegCompass. Stellen Sie Ihre Compliance-Fragen — gestützt auf ${TOTAL_REQS} verifizierte regulatorische Anforderungen aus ${TOTAL_REGS} Gesetzen.`,
};

// Reads the auth cookie → opts this route into dynamic rendering. AEGIS spends
// Claude API tokens, so it is gated: unauthenticated visitors go to /login;
// signed-in but unapproved accounts see a holding notice.
export default async function AegisPage() {
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/aegis');
  if (!isApproved(user)) {
    return <AccessNotice email={user.email} blocked={user.status === 'BLOCKED'} />;
  }

  const isAdmin = requireAdmin(user);

  return (
    <AegisChatPanel totalRequirements={TOTAL_REQS} totalRegulations={TOTAL_REGS} isAdmin={isAdmin} />
  );
}

function AccessNotice({ email, blocked }: { email: string; blocked: boolean }) {
  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center rounded-2xl border border-border-brand bg-surface/50 p-8">
        <div className="text-4xl mb-4">{blocked ? '\u{1F6AB}' : '\u{23F3}'}</div>
        <h1 className="text-xl font-heading font-bold mb-2">
          {blocked ? 'Zugang gesperrt' : 'Konto wartet auf Freigabe'}
        </h1>
        <p className="text-sm text-text-secondary mb-1">
          {blocked
            ? 'Ihr Zugang zu AEGIS wurde deaktiviert.'
            : 'Ihr Konto wurde erstellt, muss aber von einem Administrator freigegeben werden, bevor Sie AEGIS nutzen können.'}
        </p>
        <p className="text-xs text-text-secondary/70 mb-6">
          Angemeldet als <span className="font-mono">{email}</span>
        </p>
        <div className="flex items-center justify-center gap-3">
          <AegisLogoutButton className="px-4 py-2 rounded-lg border border-border-brand text-sm text-text-secondary hover:text-brand-primary hover:border-brand-primary/50 transition-colors">
            Abmelden
          </AegisLogoutButton>
          <Link
            href="/"
            className="px-4 py-2 rounded-lg bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 transition-colors no-underline"
          >
            Zur Startseite
          </Link>
        </div>
      </div>
    </div>
  );
}
