import requirementsData from './requirements.json';
import regulationsData from './regulations.json';
import crosswalkData from './crosswalk.json';
import manifestData from './manifest.json';
import { Requirement, RegulationMeta, CrosswalkEntry, KbManifest } from './types';
import { z } from 'zod';

const requirements = z.array(Requirement).parse(requirementsData);
const regulations = z.array(RegulationMeta).parse(regulationsData);
const crosswalk = z.array(CrosswalkEntry).parse(crosswalkData);
const manifest = KbManifest.parse(manifestData);

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
