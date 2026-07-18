import { KB } from '@/lib/kb';
import { RegulationGraph } from '@/components/RegulationGraph';
import type { GraphNode, GraphEdge } from '@/components/RegulationGraph';
import Compass3D from '@/components/Compass3D';
import Link from 'next/link';

function inferRegulation(reqId: string): string | null {
  const req = KB.byId(reqId);
  if (req) return req.regulation;
  const prefixMap: Record<string, string> = {
    'R-AIACT': 'EU_AI_ACT', 'R-DORA': 'DORA', 'R-GDPR': 'GDPR', 'R-NIS2': 'NIS2',
    'R-DSA': 'DSA', 'R-DATAACT': 'DATA_ACT', 'R-PRODLIAB': 'PRODUCT_LIABILITY',
    'R-FINMA': 'FINMA_08_2024', 'R-FINMARS1': 'FINMA_RS_2023_1', 'R-FINMARS3': 'FINMA_RS_2018_3',
    'R-REVDSG': 'REVDSG', 'R-BDSG': 'BDSG', 'R-BSIG': 'BSIG',
    'R-MARISK': 'MARISK', 'R-BAIT': 'BAIT',
    'R-ISO42001': 'ISO_42001', 'R-ISO42005': 'ISO_42005', 'R-ISO23894': 'ISO_23894',
    'R-NIST': 'NIST_AI_RMF',
  };
  for (const [prefix, reg] of Object.entries(prefixMap)) {
    if (reqId.startsWith(prefix)) return reg;
  }
  return null;
}

function buildGraphData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const regCounts = new Map<string, number>();
  for (const stat of KB.stats.byRegulation) regCounts.set(stat.id, stat.count);

  const nodes: GraphNode[] = KB.regulations.map((r) => ({
    id: r.id, label: r.shortName, jurisdiction: r.jurisdiction,
    bindingLevel: r.bindingLevel, requirementCount: regCounts.get(r.id) || 0,
  }));

  const edgeMap = new Map<string, { topics: string[]; weight: number }>();
  for (const entry of KB.crosswalk) {
    const regsInEntry = new Set<string>();
    for (const reqId of entry.requirements) {
      const reg = inferRegulation(reqId);
      if (reg) regsInEntry.add(reg);
    }
    const regArr = [...regsInEntry];
    for (let i = 0; i < regArr.length; i++) {
      for (let j = i + 1; j < regArr.length; j++) {
        const key = [regArr[i], regArr[j]].sort().join('|');
        if (!edgeMap.has(key)) edgeMap.set(key, { topics: [], weight: 0 });
        const e = edgeMap.get(key)!;
        e.topics.push(entry.topic);
        e.weight++;
      }
    }
  }

  const thematicEdges: [string, string, string][] = [
    ['DSA', 'EU_AI_ACT', 'AI Transparency & Digital Services'],
    ['DSA', 'GDPR', 'User Data Protection'],
    ['DATA_ACT', 'GDPR', 'Data Governance & Access Rights'],
    ['DATA_ACT', 'DORA', 'Data Access in Financial Services'],
    ['PRODUCT_LIABILITY', 'EU_AI_ACT', 'AI Product Safety & Liability'],
    ['PRODUCT_LIABILITY', 'GDPR', 'Defective Processing Liability'],
    ['FINMA_RS_2023_1', 'DORA', 'Operational Resilience'],
    ['FINMA_RS_2023_1', 'FINMA_08_2024', 'FINMA Supervisory Framework'],
    ['FINMA_RS_2023_1', 'FINMA_RS_2018_3', 'FINMA Circular Family'],
    ['FINMA_RS_2018_3', 'FINMA_08_2024', 'AI Outsourcing Governance'],
    ['FINMA_RS_2018_3', 'DORA', 'Third-Party ICT Risk'],
    ['ISO_42001', 'EU_AI_ACT', 'AI Compliance Framework'],
    ['ISO_42001', 'NIST_AI_RMF', 'Complementary AI Standards'],
    ['ISO_42001', 'ISO_23894', 'ISO AI Standard Family'],
    ['ISO_42001', 'ISO_42005', 'ISO AI Standard Family'],
    ['ISO_42005', 'GDPR', 'Impact Assessment Methodology'],
    ['ISO_42005', 'EU_AI_ACT', 'FRIA Methodology'],
    ['ISO_23894', 'EU_AI_ACT', 'AI Risk Management Framework'],
    ['ISO_23894', 'NIST_AI_RMF', 'Risk Management Alignment'],
    ['NIST_AI_RMF', 'EU_AI_ACT', 'AI Governance Framework'],
  ];
  for (const [a, b, topic] of thematicEdges) {
    const key = [a, b].sort().join('|');
    if (!edgeMap.has(key)) edgeMap.set(key, { topics: [topic], weight: 1 });
  }

  const edges: GraphEdge[] = [];
  for (const [key, val] of edgeMap) {
    const [source, target] = key.split('|');
    edges.push({ source, target, topics: val.topics, weight: val.weight });
  }
  return { nodes, edges };
}

const TOTAL_REQS = KB.stats.totalRequirements;
const TOTAL_CTRLS = KB.stats.totalControls;
const TOTAL_REGS = KB.regulations.length;
const OTHER_REGS = TOTAL_REGS - 6;

const STEPS = [
  { icon: '\u{1F4AC}', title: 'Fragen', desc: 'Stellen Sie AEGIS Ihre Compliance-Frage — auf Deutsch oder Englisch, zu jeder Regulation.' },
  { icon: '\u{1F50D}', title: 'Analysieren', desc: `${TOTAL_REQS} verifizierte Anforderungen werden durchsucht und mit den geltenden Vorschriften verglichen.` },
  { icon: '\u{1F4CB}', title: 'Verstehen', desc: 'Erhalten Sie eine quellenbasierte Analyse mit konkreten Handlungsempfehlungen und KB-Zitaten.' },
];

const FEATURES = [
  { title: 'AEGIS KI-Berater', desc: 'Stellen Sie Compliance-Fragen in natürlicher Sprache. AEGIS analysiert, vergleicht und empfiehlt basierend auf der geprüften Wissensbasis.' },
  { title: `${TOTAL_REQS} Anforderungen`, desc: `EU AI Act, FINMA 08/2024, DORA, GDPR, NIS2, revDSG und ${OTHER_REGS} weitere Regulierungen — vollständig kategorisiert.` },
  { title: `${TOTAL_CTRLS} Kontrollmassnahmen`, desc: 'Konkrete Handlungsempfehlungen basierend auf ISO 42001, ISO 42005 und NIST AI RMF.' },
  { title: 'Auditierbar', desc: 'Jede AEGIS-Konversation wird mit Quellen, Kosten und Zeitstempel protokolliert.' },
];

const BINDING_INDICATORS = [
  { color: 'bg-red-500', label: 'Verpflichtend', desc: 'Gesetzlich vorgeschrieben (EU AI Act, DORA, GDPR)' },
  { color: 'bg-yellow-500', label: 'Aufsichtsrechtlich', desc: 'Von der Aufsicht erwartet (FINMA, BaFin)' },
  { color: 'bg-blue-500', label: 'Best Practice', desc: 'Branchenstandard (ISO, NIST)' },
];

export default function Home() {
  const { nodes, edges } = buildGraphData();
  const { totalRequirements, totalControls, totalCrosswalk } = KB.stats;

  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Hero */}
      <section className="pt-20 pb-8 text-center px-4">
        <div className="inline-block px-3 py-1 text-xs font-mono uppercase tracking-wider bg-cyan-500/10 text-cyan-400 rounded-full border border-cyan-500/20 mb-6">
          {totalRequirements} Anforderungen &middot; {totalControls} Kontrollen &middot; {KB.regulations.length} Regulierungen
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-4 font-heading">
          RegCompass
        </h1>
        <p className="text-lg md:text-xl text-text-secondary max-w-2xl mx-auto mb-4">
          KI-Regulatorik auf einen Blick — gestützt auf {totalRequirements} verifizierte Anforderungen
        </p>
        <p className="text-sm text-text-secondary/80 max-w-xl mx-auto mb-8">
          Stellen Sie AEGIS Ihre Compliance-Fragen — der KI-Berater analysiert, vergleicht und empfiehlt basierend auf der geprüften Wissensbasis.
        </p>
        <div className="flex justify-center mb-8">
          <Compass3D className="w-64 h-64 md:w-80 md:h-80" />
        </div>
        <div className="flex gap-4 justify-center flex-wrap">
          <Link
            href="/aegis"
            className="px-6 py-3 bg-brand-primary text-black font-semibold rounded-lg hover:bg-cyan-400 transition"
          >
            AEGIS fragen
          </Link>
          <Link
            href="/kb"
            className="px-6 py-3 border border-border-brand text-text-secondary rounded-lg hover:border-brand-primary transition"
          >
            Wissensdatenbank
          </Link>
        </div>
      </section>

      {/* Network Graph */}
      <section className="w-full px-4 py-12">
        <p className="text-center text-sm text-text-secondary mb-4">
          {KB.regulations.length} Regulierungen &middot; {totalCrosswalk} Verbindungen &middot; Ein System
        </p>
        <div className="max-w-6xl mx-auto rounded-xl border border-border-brand bg-surface/50 overflow-hidden">
          <RegulationGraph nodes={nodes} edges={edges} />
        </div>
      </section>

      {/* How It Works */}
      <section className="max-w-5xl mx-auto px-4 py-16">
        <h2 className="text-2xl md:text-3xl font-bold font-heading text-center mb-12">So funktioniert es</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {STEPS.map((step, i) => (
            <div key={i} className="text-center">
              <div className="text-4xl mb-4">{step.icon}</div>
              <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-brand-primary/10 text-brand-primary text-sm font-bold mb-3">
                {i + 1}
              </div>
              <h3 className="text-lg font-semibold font-heading mb-2">{step.title}</h3>
              <p className="text-sm text-text-secondary">{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-4 py-16">
        <h2 className="text-2xl md:text-3xl font-bold font-heading text-center mb-12">Auf einen Blick</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {FEATURES.map((f, i) => (
            <div key={i} className="p-6 rounded-xl border border-border-brand bg-surface/50">
              <h3 className="text-lg font-semibold font-heading mb-2">{f.title}</h3>
              <p className="text-sm text-text-secondary">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Binding Levels */}
      <section className="max-w-4xl mx-auto px-4 py-16">
        <h2 className="text-xl md:text-2xl font-bold font-heading text-center mb-2">
          Pflicht vs. Empfehlung — klar getrennt
        </h2>
        <p className="text-sm text-text-secondary text-center mb-8">
          Jede Anforderung ist nach Verbindlichkeit klassifiziert.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {BINDING_INDICATORS.map((b, i) => (
            <div key={i} className="flex items-start gap-3 p-4 rounded-xl border border-border-brand bg-surface/50">
              <span className={`w-3 h-3 rounded-full mt-1 shrink-0 ${b.color}`} />
              <div>
                <p className="font-semibold text-sm">{b.label}</p>
                <p className="text-xs text-text-secondary mt-1">{b.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Stats */}
      <section className="max-w-4xl mx-auto px-4 py-12 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 rounded-xl border border-border-brand bg-surface/50 text-center">
          <p className="text-4xl font-bold text-cyan-400">{totalRequirements}</p>
          <p className="text-sm text-text-secondary mt-1">Anforderungen</p>
          <p className="text-xs text-text-secondary/60 mt-2">Aus {KB.regulations.length} Regulierungen (EU, CH, DE, INTL)</p>
        </div>
        <div className="p-6 rounded-xl border border-border-brand bg-surface/50 text-center">
          <p className="text-4xl font-bold text-cyan-400">{totalControls}</p>
          <p className="text-sm text-text-secondary mt-1">Kontrollmassnahmen</p>
          <p className="text-xs text-text-secondary/60 mt-2">ISO 42001, ISO 23894, NIST AI RMF</p>
        </div>
        <div className="p-6 rounded-xl border border-border-brand bg-surface/50 text-center">
          <p className="text-4xl font-bold text-cyan-400">{totalCrosswalk}</p>
          <p className="text-sm text-text-secondary mt-1">Querverweise</p>
          <p className="text-xs text-text-secondary/60 mt-2">Überlappende Pflichten über Jurisdiktionen</p>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center py-16 px-4">
        <h2 className="text-2xl font-bold font-heading mb-4">Bereit für Ihre erste Analyse?</h2>
        <div className="flex flex-col items-center gap-3">
          <Link
            href="/aegis"
            className="px-8 py-3.5 bg-brand-primary text-black font-semibold rounded-lg hover:bg-cyan-400 transition text-lg"
          >
            AEGIS fragen
          </Link>
          <Link href="/kb" className="text-sm text-text-secondary hover:text-brand-primary transition">
            oder erkunden Sie die Wissensdatenbank &rarr;
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center pb-8 px-4">
        <p className="text-xs text-text-secondary/60">
          RegCompass Open &middot; nicht rechtsberatend
        </p>
        <div className="flex justify-center gap-4 mt-2">
          <span className="text-xs text-text-secondary/40">Impressum</span>
          <span className="text-xs text-text-secondary/40">Datenschutz</span>
        </div>
      </footer>
    </main>
  );
}
