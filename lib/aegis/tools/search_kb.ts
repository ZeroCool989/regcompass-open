import type Anthropic from '@anthropic-ai/sdk';
import { KB } from '@/lib/kb';
import type { Requirement } from '@/lib/kb/types';

/**
 * Anthropic tool schema — exact form from
 * docs/superpowers/specs/aegis-phase-1.md §4.4.
 */
export const SEARCH_KB_SCHEMA: Anthropic.Tool = {
  name: 'search_kb',
  description:
    'Search the RegCompass knowledge base for regulatory requirements. ' +
    'Returns up to 10 matching requirements with their ID, title, regulation, article, summary, bindingLevel, jurisdiction, audience, and category. ' +
    "The `body` field is omitted to save tokens — call again with the same `query` set to the requirement's ID to retrieve a single full record.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text query in DE or EN. Searched in title, summary, id, tags, and control actions.',
      },
      regulation: {
        type: 'string',
        enum: [
          'EU_AI_ACT',
          'DORA',
          'GDPR',
          'NIS2',
          'DSA',
          'DATA_ACT',
          'PRODUCT_LIABILITY',
          'FINMA_08_2024',
          'FINMA_RS_2023_1',
          'FINMA_RS_2018_3',
          'REVDSG',
          'BDSG',
          'BSIG',
          'MARISK',
          'BAIT',
          'ISO_42001',
          'ISO_42005',
          'ISO_23894',
          'NIST_AI_RMF',
        ],
      },
      jurisdiction: {
        type: 'string',
        enum: ['EU', 'CH', 'DE', 'INTL'],
      },
      bindingLevel: {
        type: 'string',
        enum: ['mandatory', 'supervisory_expectation', 'best_practice'],
      },
      audience: {
        type: 'string',
        enum: [
          'provider',
          'deployer',
          'authority',
          'all',
          'gpai-provider',
          'importer',
          'distributor',
          'authorised-representative',
          'financial-entity',
          'ict-third-party-provider',
        ],
      },
      category: {
        type: 'string',
        description:
          'KB category slug (e.g. "governance", "risk-management", "data-governance", "human-oversight", "transparency", "third-party-risk"). ' +
          'Use only when you are certain — leave empty for broad searches.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        default: 5,
      },
    },
    required: ['query'],
  },
};

// ───────────────────────── Executor ─────────────────────────

type SearchKbInput = {
  query: string;
  regulation?: string;
  jurisdiction?: 'EU' | 'CH' | 'DE' | 'INTL';
  bindingLevel?: 'mandatory' | 'supervisory_expectation' | 'best_practice';
  audience?: string;
  category?: string;
  limit?: number;
};

type RequirementSummary = Omit<Requirement, 'body'>;

/**
 * German ↔ English regulatory-term synonyms. Keys are lowercase. Single-word
 * keys are expanded per token; multi-word keys are expanded if the full
 * lowercased query matches the key exactly. Expansion targets are checked
 * as substrings against the same fields as the original tokens.
 *
 * This lets the agent retrieve GDPR entries when the user writes "DSGVO",
 * EU AI Act entries for "KI-Verordnung", MaRisk for "Mindestanforderungen",
 * R-GDPR-022 for "automatisierte Entscheidung", etc.
 */
const SYNONYMS: Record<string, string[]> = {
  // — Regulation short-names (DE → EN) —
  dsgvo: ['gdpr'],
  'datenschutz-grundverordnung': ['gdpr'],
  datenschutzgrundverordnung: ['gdpr'],
  'ki-verordnung': ['eu ai act', 'eu_ai_act', 'aiact'],
  'ki-vo': ['eu ai act', 'eu_ai_act', 'aiact'],
  'ki-gesetz': ['eu ai act', 'eu_ai_act', 'aiact'],
  'kuenstliche-intelligenz-verordnung': ['eu ai act'],
  'dora-verordnung': ['dora'],
  'digital operational resilience act': ['dora'],
  'nis-2-richtlinie': ['nis2'],
  'nis2-richtlinie': ['nis2'],
  'nis 2': ['nis2'],
  'digital services act': ['dsa'],
  'digitale-dienste-gesetz': ['dsa'],
  datengesetz: ['data act', 'data_act'],
  'data-act': ['data act', 'data_act'],
  produkthaftungsrichtlinie: ['product liability'],
  bundesdatenschutzgesetz: ['bdsg'],
  'bsi-gesetz': ['bsig'],
  mindestanforderungen: ['marisk'],
  'mindestanforderungen-an-das-risikomanagement': ['marisk'],
  'bankaufsichtliche anforderungen': ['bait'],
  'bankaufsichtliche anforderungen an die it': ['bait'],
  'finma-aufsichtsmitteilung': ['finma 08/2024', 'finma_08_2024'],
  'revidiertes datenschutzgesetz': ['revdsg'],
  'revidiertes-dsg': ['revdsg'],

  // — Regulation short-names (EN → DE) — useful for English queries
  //   that should still surface DE/CH entries with German body text.
  gdpr: ['dsgvo'],

  // — Concepts (DE → EN) —
  ki: ['ai'],
  'künstliche intelligenz': ['artificial intelligence', 'ai'],
  'künstlicher intelligenz': ['artificial intelligence', 'ai'],
  'künstliche-intelligenz': ['artificial intelligence', 'ai'],
  automatisiert: ['automated'],
  automatisierte: ['automated'],
  automatisierten: ['automated'],
  automatisierter: ['automated'],
  automatisches: ['automated'],
  entscheidung: ['decision'],
  entscheidungen: ['decisions'],
  entscheidungsfindung: ['decision-making', 'decision making'],
  'automatisierte entscheidung': ['automated decision', 'automated decision-making'],
  'automatisierte entscheidungen': ['automated decisions'],
  'automatisierte entscheidungsfindung': ['automated decision-making'],
  profilbildung: ['profiling'],
  profilerstellung: ['profiling'],
  auftragsverarbeiter: ['processor'],
  verantwortlicher: ['controller'],
  meldepflicht: ['notification', 'reporting'],
  datenpanne: ['data breach', 'breach'],
  grundsätze: ['principles'],
  grundsatz: ['principle'],
  datenübertragbarkeit: ['portability'],
  datenportabilität: ['portability'],
  'datenschutz-folgenabschätzung': ['data protection impact assessment', 'dpia'],
  dsfa: ['data protection impact assessment', 'dpia'],
  dpia: ['datenschutz-folgenabschätzung'],
  auskunftsrecht: ['right of access'],
  'recht auf löschung': ['right to erasure', 'erasure'],
  'recht auf vergessenwerden': ['right to be forgotten', 'erasure'],
  rechenschaftspflicht: ['accountability'],
  datenminimierung: ['data minimisation', 'minimisation'],
  zweckbindung: ['purpose limitation'],
  einwilligung: ['consent'],
  datenschutzbeauftragter: ['data protection officer', 'dpo'],
  aufsichtsbehörde: ['supervisory authority'],
  risikomanagement: ['risk management'],
  transparenz: ['transparency'],
  sicherheit: ['security'],
  auslagerung: ['outsourcing'],
  auslagerungen: ['outsourcing'],
  kreditscoring: ['credit scoring'],
  biometrisch: ['biometric'],
  biometrische: ['biometric'],
  hochrisiko: ['high-risk', 'high risk'],
  'verbotene praktiken': ['prohibited practices'],
};

// Split on whitespace, lowercase, strip leading/trailing punctuation (but
// keep internal hyphens, which are meaningful for compounds like
// "ki-verordnung" or "art."→"art"). Drop tokens with length < 2 — except
// for numeric tokens which we keep at any length so that article numbers
// like "5" in "Art. 5" are not dropped.
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\wäöüß-]+|[^\wäöüß-]+$/g, ''))
    .filter((t) => t.length > 1 || /^\d+$/.test(t));
}

function expandSynonyms(fullQuery: string, tokens: string[]): Set<string> {
  const expansions = new Set<string>();
  const full = fullQuery.toLowerCase().trim();
  if (SYNONYMS[full]) {
    for (const s of SYNONYMS[full]) expansions.add(s);
  }
  for (const tok of tokens) {
    if (SYNONYMS[tok]) {
      for (const s of SYNONYMS[tok]) expansions.add(s);
    }
  }
  return expansions;
}

// Custom word-boundary check. JS's default `\b` treats `_` as a word char
// — that breaks matching "FINMA" in "FINMA_08_2024". This boundary treats
// any char outside [a-z0-9äöüß] as a separator, which correctly handles
// underscores in regulation IDs, hyphens in compounds, and dots in article
// references like "Art. 5".
const WORD_CHAR_CLASS = 'a-z0-9äöüß';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordMatch(field: string, term: string): boolean {
  if (term.length === 0) return false;
  const re = new RegExp(
    `(?:^|[^${WORD_CHAR_CLASS}])${escapeRegex(term)}(?=$|[^${WORD_CHAR_CLASS}])`,
  );
  return re.test(field);
}

/**
 * Multi-field scoring with German↔English synonyms.
 *
 * 1. Exact ID match → 1000. ID substring → 800.
 * 2. Full-query substring across all fields, weighted by field importance:
 *    article > title > regulation > summary > body > tags > controls.
 * 3. Per-token substring (after tokenize + lowercase + punctuation strip).
 * 4. Per-synonym-expansion substring (covers DE↔EN queries like
 *    "DSGVO" → "GDPR", "Grundsätze" → "principles").
 *
 * Scores accumulate across all matched fields and tokens, so a query that
 * hits multiple fields (e.g. "Art. 5 DSGVO" matches article + regulation)
 * outranks an entry that hits only one.
 */
function scoreMatch(query: string, r: Requirement): number {
  const q = query.toLowerCase().trim();

  const id = r.id.toLowerCase();
  if (id === q) return 1000;
  if (id.includes(q)) return 800;

  const title = r.title.toLowerCase();
  const article = r.article.toLowerCase();
  const regulation = r.regulation.toLowerCase();
  const summary = r.summary.toLowerCase();
  const body = r.body.toLowerCase();
  const tags = r.tags.join(' ').toLowerCase();
  const controls = r.controls.map((c) => c.action).join(' ').toLowerCase();

  let score = 0;

  // 1. Full-query substring across all fields.
  if (article.includes(q)) score += 200;
  if (title.includes(q)) score += 100;
  if (regulation.includes(q)) score += 150;
  if (summary.includes(q)) score += 50;
  if (body.includes(q)) score += 30;
  if (tags.includes(q)) score += 20;
  if (controls.includes(q)) score += 10;

  // 2. Per-token word-boundary match (handles multi-word queries where the
  //    full phrase doesn't appear contiguously in any field). Word-boundary
  //    matching prevents false positives like token "art" matching inside
  //    "party" or "third-party-obligations". The regulation field has a
  //    high weight because it's an exact identifier, not free-form text.
  const tokens = tokenize(q);
  if (tokens.length > 0) {
    for (const tok of tokens) {
      if (wordMatch(article, tok)) score += 60;
      if (wordMatch(title, tok)) score += 40;
      if (wordMatch(regulation, tok)) score += 100;
      if (wordMatch(summary, tok)) score += 15;
      if (wordMatch(body, tok)) score += 8;
      if (wordMatch(tags, tok)) score += 6;
    }
  }

  // 3. Synonym expansion (DE↔EN regulatory terms), also word-boundary matched
  //    so "gdpr" doesn't accidentally hit "gdpr-alignment" alone — it must
  //    appear as a standalone token in some field. Synonym matches on the
  //    regulation field are especially valued because they indicate the
  //    user used a translation (e.g. DSGVO → GDPR) to find the regulator.
  const expansions = expandSynonyms(q, tokens);
  for (const syn of expansions) {
    if (wordMatch(article, syn)) score += 100;
    if (wordMatch(title, syn)) score += 60;
    if (wordMatch(regulation, syn)) score += 200;
    if (wordMatch(summary, syn)) score += 25;
    if (wordMatch(body, syn)) score += 12;
    if (wordMatch(tags, syn)) score += 10;
  }

  return score;
}

export function executeSearchKb(input: SearchKbInput): RequirementSummary[] {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

  let candidates: Requirement[] = KB.requirements;

  if (input.regulation) {
    candidates = candidates.filter((r) => r.regulation === input.regulation);
  }
  if (input.jurisdiction) {
    candidates = candidates.filter((r) =>
      r.jurisdiction.includes(input.jurisdiction!),
    );
  }
  if (input.bindingLevel) {
    candidates = candidates.filter((r) => r.bindingLevel === input.bindingLevel);
  }
  if (input.audience) {
    candidates = candidates.filter((r) =>
      r.audience.some((a) => a === input.audience),
    );
  }
  if (input.category) {
    candidates = candidates.filter((r) => r.category === input.category);
  }

  return candidates
    .map((r) => ({ r, s: scoreMatch(input.query, r) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r }) => {
      // Strip the verbose `body` field — agent can fetch it on demand by querying the ID.
      const { body: _body, ...summary } = r;
      return summary;
    });
}
