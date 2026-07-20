import { getClient } from '@/lib/aegis/client';
import { MODEL_IDS } from '@/lib/aegis/types';
import { OFFICIAL_SOURCES } from './sources';
import { dedupeNews, dedupeSuggestions } from './dedupe';
import { loadFeeds, type RegulatoryFeed } from './feeds';
import { feedDateToIso, parseFeed, type RawFeedItem } from './rss';
import { KbSuggestionSchema, NewsItemSchema, type NewsItem, type ResearchResult } from './types';

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

// ───────────────────────── RSS provider (no LLM) ─────────────────────────

/** Canonical topic tags derived deterministically from title + summary text. */
const TAG_RULES: Array<{ tag: string; re: RegExp }> = [
  { tag: 'DORA', re: /\bdora\b/i },
  { tag: 'NIS2', re: /\bnis\s?2\b/i },
  { tag: 'AI Act', re: /\bai act\b|\bki[- ]?verordnung\b|artificial intelligence act/i },
  { tag: 'CRA', re: /\bcra\b|cyber resilience/i },
  { tag: 'MiCA', re: /\bmica\b/i },
  { tag: 'Datenschutz', re: /\bgdpr\b|\bdsgvo\b|datenschutz|data protection/i },
  { tag: 'PSD2', re: /\bpsd\s?2\b|\bpsd\s?3\b/i },
  { tag: 'Cybersecurity', re: /cybersecurity|cyber-?sicherheit|it-?sicherheit/i },
  { tag: 'AML', re: /\baml\b|geldwäsche|anti-money/i },
];

function deriveTags(text: string): string[] {
  return TAG_RULES.filter((r) => r.re.test(text)).map((r) => r.tag).slice(0, 12);
}

/** http(s), named host, no loopback/IP — SSRF guard for feed fetches. */
function isSafeFeedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // hostname (not host) so a :port can't hide an IP literal from the guard.
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (!h.includes('.') || h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Map one raw feed item + its feed to a NewsItem, or null if it can't be built. */
function toNewsItem(raw: RawFeedItem, feed: RegulatoryFeed): NewsItem | null {
  if (!isSafeFeedUrl(raw.link)) return null;
  const title = raw.title.slice(0, 300);
  const tags = deriveTags(`${raw.title} ${raw.summary}`);
  const summarySrc = raw.summary.length >= 10 ? raw.summary : title;
  const summary = (summarySrc.length >= 10 ? summarySrc : `${title} — ${feed.name}`).slice(0, 2000);
  const relevance = `Regulatorische Meldung (${feed.jurisdiction})${
    tags.length ? ` – Themen: ${tags.join(', ')}` : ''
  }`;
  const candidate = {
    title,
    summary,
    relevance,
    sourceName: feed.name,
    sourceUrl: raw.link,
    publishedAt: feedDateToIso(raw.date) ?? undefined,
    jurisdiction: feed.jurisdiction,
    tags,
  };
  const parsed = NewsItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type FeedFetchStatus = {
  name: string;
  feedUrl: string;
  ok: boolean;
  items: number;
  error?: string;
};

/**
 * Fetch + parse all feeds into fresh (last `windowDays`) news items. Each feed
 * is independent: a fetch/parse failure is captured in the status list and
 * never fails the run. LLM-free.
 */
export async function fetchRssNews(opts?: {
  feeds?: RegulatoryFeed[];
  windowDays?: number;
  maxPerFeed?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ news: NewsItem[]; status: FeedFetchStatus[] }> {
  const feeds = opts?.feeds ?? loadFeeds();
  const windowDays = opts?.windowDays ?? 7;
  const maxPerFeed = opts?.maxPerFeed ?? 30;
  const nowMs = opts?.now ?? Date.now();
  const doFetch = opts?.fetchImpl ?? fetch;
  const cutoff = new Date(nowMs - windowDays * 86_400_000).toISOString().slice(0, 10);

  const status: FeedFetchStatus[] = [];
  const collected: NewsItem[] = [];

  for (const feed of feeds) {
    if (!isSafeFeedUrl(feed.feedUrl)) {
      status.push({ name: feed.name, feedUrl: feed.feedUrl, ok: false, items: 0, error: 'unsafe_url' });
      continue;
    }
    try {
      const res = await doFetch(feed.feedUrl, {
        headers: { 'user-agent': 'regcompass-open/regulatory-radar', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        status.push({ name: feed.name, feedUrl: feed.feedUrl, ok: false, items: 0, error: `http_${res.status}` });
        continue;
      }
      const xml = await res.text();
      const items = parseFeed(xml)
        // Keep items within the window; items without a parseable date are kept
        // (many regulator feeds omit dates) but capped per feed below.
        .filter((it) => {
          const iso = feedDateToIso(it.date);
          return iso === null || iso >= cutoff;
        })
        .slice(0, maxPerFeed)
        .map((it) => toNewsItem(it, feed))
        .filter((n): n is NewsItem => n !== null);
      collected.push(...items);
      status.push({ name: feed.name, feedUrl: feed.feedUrl, ok: true, items: items.length });
    } catch (err) {
      status.push({
        name: feed.name,
        feedUrl: feed.feedUrl,
        ok: false,
        items: 0,
        error: err instanceof Error ? err.message.slice(0, 120) : 'fetch_failed',
      });
    }
  }

  return { news: dedupeNews(collected), status };
}

/**
 * LLM-free radar backend: pulls official regulator RSS/Atom feeds and maps them
 * to news items with deterministic tags/relevance. Produces NO KB suggestions
 * (proposing KB changes needs judgment the feeds don't provide). Per-feed
 * outcomes are logged so a stale feed URL is visible in the run output.
 */
export class RssResearchProvider implements RegulatoryResearchProvider {
  async research(): Promise<ResearchResult> {
    const { news, status } = await fetchRssNews();
    for (const s of status) {
      console.log(
        JSON.stringify({ event: 'regulatory_feed', name: s.name, ok: s.ok, items: s.items, ...(s.error ? { error: s.error } : {}) }),
      );
    }
    return { news, suggestions: [] };
  }
}

export const rssResearchProvider: RegulatoryResearchProvider = new RssResearchProvider();

/**
 * Pick the radar backend from env. Default is the LLM-free RSS provider — the
 * open build needs no model to refresh news. Set REGULATORY_NEWS_PROVIDER=llm
 * to use Claude + web_search instead (requires a configured Anthropic brain).
 */
export function selectResearchProvider(env: NodeJS.ProcessEnv = process.env): RegulatoryResearchProvider {
  return env.REGULATORY_NEWS_PROVIDER?.trim().toLowerCase() === 'llm'
    ? defaultResearchProvider
    : rssResearchProvider;
}
