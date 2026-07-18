import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { HistoryTable } from '@/components/HistoryTable';
import { ConversationHistory } from '@/components/ConversationHistory';
import { getUserFromCookies, isApproved } from '@/lib/auth';

export const metadata = {
  title: 'AEGIS-Verlauf | RegCompass',
  description: 'Alle AEGIS-Konversationen im Überblick — Modus, Kosten, Qualität.',
};

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  // Every approved user reaches their own conversation history here (the
  // ConversationHistory list is session/user-scoped) — the navbar and account
  // menu link to it for everyone (finding F1). The AegisUsageLog table below
  // is cross-user telemetry (cost, tokens, model, latency, exit reason) and
  // stays admin-only, same gate as /dashboard and /api/aegis/usage: it is
  // queried and rendered only for approved admins.
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/history');
  if (!isApproved(user)) redirect('/aegis');
  const isAdmin = user.role === 'ADMIN';

  if (!isAdmin) {
    return (
      <main>
        <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8">
          <h2 className="text-2xl font-bold font-heading mb-1">Meine Gespräche</h2>
          <p className="text-sm text-text-secondary mb-4">
            Öffnen Sie eine frühere Unterhaltung, um sie nachzulesen oder fortzuführen.
          </p>
          <ConversationHistory />
        </section>
      </main>
    );
  }

  const logs = await db.aegisUsageLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      createdAt: true,
      conversationId: true,
      mode: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      costCents: true,
      latencyMs: true,
      iterations: true,
      toolCalls: true,
      verifyPassed: true,
      citationCount: true,
    },
  });

  const mapped = logs.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    conversationId: l.conversationId,
    mode: l.mode,
    model: l.model,
    inputTokens: l.inputTokens,
    outputTokens: l.outputTokens,
    costCents: l.costCents,
    latencyMs: l.latencyMs,
    iterations: l.iterations,
    toolCalls: l.toolCalls,
    verifyPassed: l.verifyPassed,
    citationCount: l.citationCount,
  }));

  return (
    <main>
      <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8">
        <h2 className="text-2xl font-bold font-heading mb-1">Meine Gespräche</h2>
        <p className="text-sm text-text-secondary mb-4">
          Öffnen Sie eine frühere Unterhaltung, um sie nachzulesen oder fortzuführen.
        </p>
        <ConversationHistory />
      </section>
      <HistoryTable logs={mapped} />
    </main>
  );
}
