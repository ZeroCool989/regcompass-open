import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { JURISDICTIONS, type Jurisdiction } from './types';

/**
 * RSS/Atom feeds for the LLM-free regulatory radar. Each feed belongs to one of
 * the official sources and carries a jurisdiction so items inherit it without a
 * model call.
 *
 * These are the maintainer's best-known public feed URLs; regulators move them
 * occasionally. The radar SKIPS any feed it cannot fetch or parse (and logs
 * which), so a stale URL degrades one source, never the whole run. Bring your
 * own list by pointing REGULATORY_FEEDS_FILE at a JSON file with the same shape
 * — the local owner fully controls which sources are polled.
 */

export type RegulatoryFeed = {
  name: string;
  jurisdiction: Jurisdiction;
  feedUrl: string;
};

export const RegulatoryFeedSchema = z.object({
  name: z.string().trim().min(2).max(120),
  jurisdiction: z.enum(JURISDICTIONS),
  feedUrl: z.string().trim().url(),
});

// Verified live (2026-07): each returns a real RSS/Atom document. BaFin, ENISA
// and EIOPA had no discoverable current feed URL and were left out rather than
// shipped as guaranteed 404s — add them via REGULATORY_FEEDS_FILE if you find
// their current feeds. Coverage here spans all three jurisdictions.
export const DEFAULT_FEEDS: RegulatoryFeed[] = [
  // EU
  { name: 'EBA', jurisdiction: 'EU', feedUrl: 'https://www.eba.europa.eu/rss.xml' },
  { name: 'ESMA', jurisdiction: 'EU', feedUrl: 'https://www.esma.europa.eu/rss.xml' },
  // Germany
  {
    name: 'Deutsche Bundesbank',
    jurisdiction: 'DE',
    feedUrl: 'https://www.bundesbank.de/service/rss/de/633286/feed.rss',
  },
  // Switzerland
  { name: 'FINMA', jurisdiction: 'CH', feedUrl: 'https://www.finma.ch/en/rss/news/' },
];

/**
 * Resolve the feed list: the JSON file at REGULATORY_FEEDS_FILE when set (the
 * bring-your-own path), otherwise the curated defaults. An unreadable or invalid
 * override file throws — a misconfigured feed list should fail loudly rather
 * than silently poll nothing.
 */
export function loadFeeds(env: NodeJS.ProcessEnv = process.env): RegulatoryFeed[] {
  const file = env.REGULATORY_FEEDS_FILE?.trim();
  if (!file) return DEFAULT_FEEDS;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return z.array(RegulatoryFeedSchema).parse(parsed);
}
