export type NodeType = 'chapter' | 'article' | 'paragraph' | 'annex' | 'section' | 'subsection' | 'root';

export interface LegislationNode {
  id: string;
  type: NodeType;
  label: string;
  shortLabel: string;
  content: string;
  children: LegislationNode[];
  kbEntryIds: string[];
}

export type LegislationFormat =
  | 'eu_regulation'
  | 'eu_directive'
  | 'ch_law'
  | 'ch_circular'
  | 'ch_guidance'
  | 'de_law'
  | 'de_circular'
  | 'iso_standard'
  | 'nist_framework'
  | 'fallback';

export type Jurisdiction = 'EU' | 'CH' | 'DE' | 'INTL';

export interface SourceFile {
  regulationId: string;
  file: string;
  title: string;
  fullTitle: string;
  jurisdiction: Jurisdiction;
  format: LegislationFormat;
  sourceUrl: string | null;
  /** True for runtime-ingested radar documents (not a bundled docs/source file). */
  ingested?: boolean;
  /** AEGIS Translate metadata (only on ingested docs). */
  originalLanguage?: string | null;
  isTranslation?: boolean;
  originalDocumentId?: string | null;
}
