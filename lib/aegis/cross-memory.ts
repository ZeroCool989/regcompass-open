/**
 * Cross-conversation memory — persistent regulatory facts promoted from
 * conversation digests or saved explicitly by the model via the `save_fact`
 * tool. Tag-indexed for recall without embeddings.
 *
 * Unlike Soul entries (style-only), memory facts carry substantive compliance
 * content. They are injected as an UNCACHED trailing system block, explicitly
 * subordinated to the KB and citation rules.
 */

import { db } from '@/lib/db';
import { similarity } from './soul-health';
import { estimateTokens } from './memory-seed';
import { MemoryConfig } from './memory-config';
import type { ConversationDigest } from './digest';

// ───────────────────────── Types ─────────────────────────

export type MemoryFactCategory = 'decision' | 'conclusion' | 'open_task' | 'general';
export type MemoryFactStatus = 'active' | 'superseded' | 'archived';

export interface MemoryFactLike {
  id: string;
  content: string;
  tags: string[];
  category: MemoryFactCategory;
  status: MemoryFactStatus;
  importance: number;
  updatedAt: Date;
}

// ───────────────────────── Tag extraction ─────────────────────────

/**
 * Regulation names — same domain as the soul.ts FIREWALL, but here we EXTRACT
 * rather than reject. Extended with German-centric regulation names (MaRisk,
 * BAIT, VAIT, KAIT, KWG, WpHG, CRR, NIS2, CRA, DSA).
 */
const REGULATION_RE =
  /\b(FINMA|DSGVO|GDPR|EU[\s-]?AI[\s-]?Act|EU[\s-]?KI|DORA|FIDLEG|FINIG|FINSA|MiFID|Basel|nLPD|revDSG|MaRisk|BAIT|VAIT|KAIT|KWG|WpHG|CRR|NIS2|DSA|CRA|ISO[\s-]?\d{4,})\b/gi;

/** Citation references: [R-DORA-001] → "DORA" */
const CITATION_RE = /\[R-([A-Z0-9]+)(?:-[A-Z0-9]+)+\]/g;

/** Normalize free-text regulation names to canonical uppercase tags. */
function normalizeTag(raw: string): string {
  return raw
    .replace(/[\s-]+/g, '_')
    .replace(/^n_?lpd$/i, 'NLPD')
    .replace(/^rev_?dsg$/i, 'REVDSG')
    .toUpperCase();
}

/** Extract regulation tags from free text and citation IDs. */
export function extractRegulationTags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(REGULATION_RE)) tags.add(normalizeTag(m[1]));
  for (const m of text.matchAll(CITATION_RE)) tags.add(m[1].toUpperCase());
  return [...tags].sort();
}

// ───────────────────────── DB helpers ─────────────────────────

/** Load all active facts for a user, parsing JSON tags into string[]. */
export async function loadActiveFactsForUser(userId: string): Promise<MemoryFactLike[]> {
  const rows = await db.memoryFact.findMany({
    where: { userId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    tags: JSON.parse(r.tags) as string[],
    category: r.category as MemoryFactCategory,
    status: r.status as MemoryFactStatus,
    importance: r.importance,
    updatedAt: r.updatedAt,
  }));
}

/** Create a new MemoryFact row. */
export async function createMemoryFact(data: {
  userId: string;
  content: string;
  tags: string[];
  category: MemoryFactCategory;
  importance: number;
  sourceConversationId?: string | null;
  supersededFactId?: string | null;
}): Promise<{ id: string }> {
  const row = await db.memoryFact.create({
    data: {
      userId: data.userId,
      content: data.content,
      tags: JSON.stringify(data.tags),
      category: data.category,
      importance: Math.min(5, Math.max(1, data.importance)),
      sourceConversationId: data.sourceConversationId ?? null,
      supersededFactId: data.supersededFactId ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

/** Mark a fact as superseded (not deleted — can be restored). */
export async function markSuperseded(factId: string): Promise<void> {
  await db.memoryFact.update({
    where: { id: factId },
    data: { status: 'superseded' },
  });
}

// ───────────────────────── Promotion (digest → facts) ─────────────────────────

/** Promote digest items to persistent memory facts. Called after storeDigest(). */
export async function promoteDigestToMemory(
  userId: string,
  digest: ConversationDigest,
  conversationId: string,
): Promise<{ promoted: number; superseded: number; duplicates: number }> {
  const items: Array<{ content: string; category: MemoryFactCategory }> = [
    ...digest.decisions.map((c) => ({ content: c, category: 'decision' as const })),
    ...digest.conclusions.map((c) => ({ content: c, category: 'conclusion' as const })),
    ...digest.openTasks.map((c) => ({ content: c, category: 'open_task' as const })),
    // preferencesObserved are EXCLUDED — those go to the Soul system, not Memory.
  ];

  const existing = await loadActiveFactsForUser(userId);
  let promoted = 0;
  let superseded = 0;
  let duplicates = 0;

  for (const item of items) {
    const tags = extractRegulationTags(item.content);

    // Dedup: skip if too similar to an existing active fact.
    if (existing.some((f) => similarity(f.content, item.content) >= MemoryConfig.memoryDuplicateThreshold)) {
      duplicates++;
      continue;
    }

    // Supersession: same category + overlapping tags → mark old as superseded.
    const toSupersede = existing.filter(
      (f) => f.category === item.category && f.tags.some((t) => tags.includes(t)),
    );
    for (const old of toSupersede) {
      await markSuperseded(old.id);
      superseded++;
    }

    await createMemoryFact({
      userId,
      content: item.content,
      tags,
      category: item.category,
      importance: 3,
      sourceConversationId: conversationId,
    });
    promoted++;
  }

  return { promoted, superseded, duplicates };
}

// ───────────────────────── Recall (query → ranked facts) ─────────────────────────

/** Simple word-set for keyword overlap (same approach as soul-health.ts). */
function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) out.add(w);
  return out;
}

/** Count shared words between two texts. */
function keywordOverlap(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  let count = 0;
  for (const w of sa) if (sb.has(w)) count++;
  return count;
}

/**
 * Recall the most relevant facts for a user's query. Tag-based tiered ranking:
 * exact regulation match → keyword overlap → recency → importance multiplier.
 */
export async function recallFactsForUser(
  userId: string,
  query: string,
  language: 'de' | 'en',
  maxFacts = MemoryConfig.memoryFactsBudget,
  maxTokens = MemoryConfig.memoryRecallTokenBudget,
): Promise<MemoryFactLike[]> {
  const all = await loadActiveFactsForUser(userId);
  if (all.length === 0) return [];

  const queryTags = extractRegulationTags(query);

  const scored = all.map((fact) => {
    let score = 0;
    // Tier 1: exact regulation tag match (+10 per tag).
    score += fact.tags.filter((t) => queryTags.includes(t)).length * 10;
    // Tier 2: keyword overlap (+3 per shared word).
    score += keywordOverlap(query, fact.content) * 3;
    // Tier 3: recency bonus (+1 if updated < 7 days ago).
    const daysOld = (Date.now() - fact.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld < 7) score += 1;
    // Importance multiplier.
    score *= fact.importance / 3;
    return { fact, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: MemoryFactLike[] = [];
  let tokenSpent = 0;
  for (const { fact, score } of scored) {
    if (score <= 0) break;
    if (selected.length >= maxFacts) break;
    const factTokens = estimateTokens(fact.content, language);
    if (tokenSpent + factTokens > maxTokens) break;
    selected.push(fact);
    tokenSpent += factTokens;
  }

  return selected;
}

// ───────────────────────── Rendering (facts → system block) ─────────────────────────

const CATEGORY_LABELS: Record<MemoryFactCategory, string> = {
  decision: 'Frühere Entscheidungen',
  conclusion: 'Frühere Schlussfolgerungen',
  open_task: 'Offene Aufgaben',
  general: 'Weitere Fakten',
};

/**
 * Render recalled facts into a fenced, subordinate system block. Returns null
 * when there are no facts (→ no block injected, behaviour unchanged).
 */
export function renderPriorKnowledgeBlock(facts: MemoryFactLike[]): string | null {
  if (facts.length === 0) return null;

  const byCategory = new Map<MemoryFactCategory, string[]>();
  for (const f of facts) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f.content);
    byCategory.set(f.category, list);
  }

  const sections: string[] = [];
  for (const cat of ['decision', 'conclusion', 'open_task', 'general'] as const) {
    const items = byCategory.get(cat);
    if (!items?.length) continue;
    sections.push(`${CATEGORY_LABELS[cat]}:\n${items.map((i) => `- ${i}`).join('\n')}`);
  }

  return [
    '<prior-knowledge scope="subordinate-to-kb">',
    'Aus früheren Unterhaltungen mit diesem Nutzer:',
    '',
    sections.join('\n\n'),
    '',
    'WICHTIG: Diese Fakten sind NACHRANGIG gegenüber der aktuellen Wissensbasis (KB). ' +
      'Wenn ein hier gespeicherter Fakt einem KB-Eintrag oder einer Zitation widerspricht, ' +
      'gilt die KB. Zitiere NIEMALS einen hier gespeicherten Fakt als Quelle — verwende ' +
      'ausschliesslich [R-…]-Zitationen aus der KB. Diese Fakten dienen als Kontext für die ' +
      'Gesprächsführung, nicht als regulatorische Autorität.',
    '</prior-knowledge>',
  ].join('\n');
}

/**
 * Convenience: recall + render. Fail-open — a recall error must never block a
 * chat turn. Returns null when the user has no relevant facts.
 */
export async function buildPriorKnowledgeBlock(
  userId: string,
  message: string,
  language: 'de' | 'en',
): Promise<string | null> {
  const facts = await recallFactsForUser(userId, message, language);
  return renderPriorKnowledgeBlock(facts);
}
