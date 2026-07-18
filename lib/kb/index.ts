import requirementsData from './requirements.json';
import regulationsData from './regulations.json';
import crosswalkData from './crosswalk.json';
import manifestData from './manifest.json';
import { Requirement, RegulationMeta, CrosswalkEntry, KbManifest } from './types';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// Knowledge-base location. When `KB_DIR` is set the four JSON files and a
// `source/` subfolder are read from that directory at startup (bring-your-own
// KB); otherwise the KB bundled with this repo is used. The bundled path keeps
// the static imports so no filesystem access is required at runtime.
const KB_DIR = process.env.KB_DIR?.trim() || null;

/** Directory holding the primary legislation texts (`<KB_DIR>/source` or the
 *  bundled `docs/source`). Consumed by the read_source tool. */
export const KB_SOURCE_DIR = KB_DIR
  ? path.resolve(KB_DIR, 'source')
  : path.resolve(process.cwd(), 'docs', 'source');

function loadRaw(file: string, bundled: unknown): unknown {
  if (!KB_DIR) return bundled;
  return JSON.parse(readFileSync(path.resolve(KB_DIR, file), 'utf8'));
}

const requirements = z.array(Requirement).parse(loadRaw('requirements.json', requirementsData));
const regulations = z.array(RegulationMeta).parse(loadRaw('regulations.json', regulationsData));
const crosswalk = z.array(CrosswalkEntry).parse(loadRaw('crosswalk.json', crosswalkData));
const manifest = KbManifest.parse(loadRaw('manifest.json', manifestData));

// Data-driven regulation → source-file map, derived from the loaded KB's own
// `sourceFile` fields (first non-empty wins per regulation). This replaces a
// hardcoded enum so an arbitrary KB's source texts resolve without code changes.
const regulationSourceFile = new Map<string, string>();
for (const r of requirements) {
  if (r.sourceFile && !regulationSourceFile.has(r.regulation)) {
    regulationSourceFile.set(r.regulation, r.sourceFile);
  }
}

export const KB = {
  /** Audit snapshot (KB version hash, verification coverage, checksum status).
   *  Regenerated via `npm run kb:manifest`; staleness fails validate-kb. */
  manifest,
  version: manifest.generatedAt,
  requirements,
  regulations,
  crosswalk,
  byId: (id: string) => requirements.find(r => r.id === id),
  byRegulation: (reg: string) => requirements.filter(r => r.regulation === reg),
  byJurisdiction: (jur: string) => requirements.filter(r => (r.jurisdiction as readonly string[]).includes(jur)),
  byAudience: (aud: string) => requirements.filter(r => (r.audience as readonly string[]).includes(aud)),
  byCategory: (cat: string) => requirements.filter(r => r.category === cat),
  byBindingLevel: (level: string) => requirements.filter(r => r.bindingLevel === level),
  byRelevance: (rel: string) => requirements.filter(r => r.relevanceForFinancialSector === rel),
  /** Source-text filename for a regulation, or undefined if the loaded KB has
   *  no source file for it. Derived from the KB, not a fixed table. */
  sourceFileFor: (regulation: string): string | undefined => regulationSourceFile.get(regulation),
  /** Regulation ids that have a resolvable source text in the loaded KB. */
  regulationsWithSource: [...regulationSourceFile.keys()],
  search: (query: string) => {
    const q = query.toLowerCase();
    return requirements.filter(r =>
      r.title.toLowerCase().includes(q) ||
      r.summary.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      r.tags.some(t => t.toLowerCase().includes(q)) ||
      r.controls.some(c => c.action.toLowerCase().includes(q))
    );
  },
  stats: {
    totalRequirements: requirements.length,
    totalControls: requirements.reduce((sum, r) => sum + r.controls.length, 0),
    totalCrosswalk: crosswalk.length,
    byRegulation: regulations.map(reg => ({
      ...reg,
      count: requirements.filter(r => r.regulation === reg.id).length,
    })),
  },
};
