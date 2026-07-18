import { getClient } from '@/lib/aegis/client';
import { MODEL_IDS } from '@/lib/aegis/types';
import { OFFICIAL_SOURCES } from './sources';
import { dedupeNews, dedupeSuggestions } from './dedupe';
import { KbSuggestionSchema, NewsItemSchema, type ResearchResult } from './types';

/**
 * A pluggable research backend. The default uses Claude with the web-search tool
 * over official sources. A future provider (RSS, a dedicated regulatory API, …)
 * can implement the same interface without touching the cron/storage pipeline.
 */
export interface RegulatoryResearchProvider {
  research(): Promise<ResearchResult>;
}

function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Pull the JSON object out of a model response (handles ```json fences + prose). */
export function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/**
 * Parse + validate a research model's output into a clean ResearchResult.
 * STRICT and anti-hallucination: invalid JSON yields nothing; every item must
 * have a real http(s) source URL or it is dropped; within-batch duplicates are
 * removed. No fabricated content can survive this gate.
 */
export function parseResearchResult(raw: string): ResearchResult {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonObject(raw));
  } catch {
    return { news: [], suggestions: [] };
  }
  const obj = (json ?? {}) as { news?: unknown; suggestions?: unknown };
  const rawNews = Array.isArray(obj.news) ? obj.news : [];
  const rawSuggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];

  // Validate EACH item individually so one malformed entry can't drop the whole
  // batch; then require a real http(s) source URL (anti-hallucination); then dedup.
  const news = dedupeNews(
    rawNews
      .map((x) => NewsItemSchema.safeParse(x))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((n) => isHttpUrl(n.sourceUrl)),
  );
  const suggestions = dedupeSuggestions(
    rawSuggestions
      .map((x) => KbSuggestionSchema.safeParse(x))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((s) => isHttpUrl(s.sourceUrl)),
  );
  return { news, suggestions };
}

const SOURCE_LIST = OFFICIAL_SOURCES.map((s) => `- ${s.name} (${s.jurisdiction}): ${s.url}`).join('\n');

const RESEARCH_PROMPT = `You are RegCompass's regulatory radar. Using the web_search tool, find regulatory developments from the LAST 7 DAYS relevant to AI in the European/Swiss financial sector — covering EU regulation, German legislation/supervision, Swiss legislation/FINMA, IT compliance, AI compliance/governance, and cybersecurity (DORA, NIS2, CRA, EU AI Act, GDPR/DSGVO, FADP/revDSG).

Search ONLY official/trusted sources, prioritising these domains:
${SOURCE_LIST}

Then return STRICT JSON (and nothing else) with this exact shape:
{
  "news": [
    {
      "title": "...",
      "summary": "2-4 sentence neutral summary",
      "relevance": "why it matters for the financial sector / IT compliance / AI compliance",
      "sourceName": "e.g. BaFin",
      "sourceUrl": "https://… (a REAL url you actually found via web_search)",
      "publishedAt": "YYYY-MM-DD",
      "jurisdiction": "EU" | "DE" | "CH" | "INTL",
      "tags": ["DORA","AI Act", ...]  // use the exact tag "AI Act" for EU-AI-Act items, "NIS2", "DORA", "CRA", "Datenschutz" where applicable
    }
  ],
  "suggestions": [
    {
      "sourceName": "...",
      "sourceUrl": "https://… (REAL)",
      "regulation": "e.g. DORA / EU AI Act / FINMA",
      "proposedRequirementId": "optional e.g. R-DORA-031",
      "proposedRequirementText": "the obligation, phrased as a KB requirement",
      "relevanceForFinancialSector": "critical" | "high" | "medium" | "low",
      "bindingLevel": "mandatory" | "supervisory_expectation" | "best_practice",
      "rationale": "why this is worth adding to the internal knowledge base"
    }
  ]
}

HARD RULES:
- Use ONLY sources you actually retrieved via web_search. NEVER invent a URL, title, date, or regulation.
- Every news item and every suggestion MUST have a real sourceUrl.
- If you find nothing genuinely new and relevant, return {"news": [], "suggestions": []}. Do NOT pad with filler.
- Output ONLY the JSON object.`;

/** Default provider: Claude (Sonnet) with the web-search server tool. */
export class ClaudeWebSearchResearchProvider implements RegulatoryResearchProvider {
  async research(): Promise<ResearchResult> {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL_IDS.sonnet,
      max_tokens: 8192,
      // web_search is a server-side tool: Anthropic runs the searches within this
      // single request and the model returns the final JSON. Cast keeps us
      // forward/backward compatible across SDK tool-type revisions.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] as never,
      messages: [{ role: 'user', content: RESEARCH_PROMPT }],
    });
    const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    return parseResearchResult(text);
  }
}

export const defaultResearchProvider: RegulatoryResearchProvider = new ClaudeWebSearchResearchProvider();
