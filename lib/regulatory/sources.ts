import type { Jurisdiction } from './types';

export type OfficialSource = {
  name: string;
  url: string;
  jurisdiction: Jurisdiction;
};

/**
 * The trusted, official regulatory sources the daily radar is allowed to draw
 * from. The research prompt instructs the model to ground every item in one of
 * these domains; anything from an unofficial source is treated as untrusted.
 */
export const OFFICIAL_SOURCES: OfficialSource[] = [
  // EU
  { name: 'EUR-Lex', url: 'https://eur-lex.europa.eu', jurisdiction: 'EU' },
  { name: 'European Commission', url: 'https://commission.europa.eu', jurisdiction: 'EU' },
  { name: 'EBA', url: 'https://www.eba.europa.eu', jurisdiction: 'EU' },
  { name: 'ESMA', url: 'https://www.esma.europa.eu', jurisdiction: 'EU' },
  { name: 'EIOPA', url: 'https://www.eiopa.europa.eu', jurisdiction: 'EU' },
  { name: 'ENISA', url: 'https://www.enisa.europa.eu', jurisdiction: 'EU' },
  // Germany
  { name: 'BaFin', url: 'https://www.bafin.de', jurisdiction: 'DE' },
  { name: 'Deutsche Bundesbank', url: 'https://www.bundesbank.de', jurisdiction: 'DE' },
  { name: 'Bundesnetzagentur', url: 'https://www.bundesnetzagentur.de', jurisdiction: 'DE' },
  // Switzerland
  { name: 'FINMA', url: 'https://www.finma.ch', jurisdiction: 'CH' },
  { name: 'Schweizer Bundesrat (admin.ch)', url: 'https://www.admin.ch', jurisdiction: 'CH' },
  { name: 'EDÖB', url: 'https://www.edoeb.admin.ch', jurisdiction: 'CH' },
];
