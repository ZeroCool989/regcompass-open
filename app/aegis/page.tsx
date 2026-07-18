import type { Metadata } from 'next';
import { AegisChatPanel } from '@/components/AegisChatPanel';
import { KB } from '@/lib/kb';

const TOTAL_REQS = KB.stats.totalRequirements;
const TOTAL_REGS = KB.regulations.length;

export const metadata: Metadata = {
  title: 'AEGIS — Der KI-Regulatorik-Berater von RegCompass',
  description: `AEGIS ist der AI-Agent von RegCompass. Stellen Sie Ihre Compliance-Fragen — gestützt auf ${TOTAL_REQS} verifizierte regulatorische Anforderungen aus ${TOTAL_REGS} Gesetzen.`,
};

// Local single-user build: no auth gate. AEGIS runs on the model the user has
// configured (their own key or subscription), so there is nothing to gate.
export default function AegisPage() {
  return (
    <AegisChatPanel totalRequirements={TOTAL_REQS} totalRegulations={TOTAL_REGS} isAdmin />
  );
}
