/**
 * Seed glossary of key regulatory terms with their canonical DE/EN renderings.
 *
 * v1 uses this ONLY to drive the translation quality check (term-consistency
 * warnings — `lib/translate/quality.ts`). It is intentionally NOT a translation
 * memory: DeepL still performs the translation. A later phase can promote this
 * into an approved-term store wired into DeepL's glossary feature
 * (`createGlossary` / `glossaryId`) without reshaping the translation service.
 */

export type TargetLang = 'DE' | 'EN';

export type RegulatoryTerm = {
  /** Stable concept key. */
  key: string;
  /** Canonical rendering per target language. */
  canonical: Record<TargetLang, string>;
  /**
   * Other surface forms that mean the SAME concept in the target language.
   * Used to detect inconsistent rendering within a single translation. All
   * lowercase; matched case-insensitively on word boundaries.
   */
  variants: Record<TargetLang, string[]>;
};

/**
 * Curated key terms. The `canonical` form is what an approved glossary would
 * enforce later; `variants` are acceptable-but-inconsistent renderings that, if
 * mixed within one document, indicate the translation drifted.
 */
export const KEY_REGULATORY_TERMS: RegulatoryTerm[] = [
  {
    key: 'ict',
    canonical: { DE: 'IKT', EN: 'ICT' },
    variants: {
      DE: ['ikt', 'informations- und kommunikationstechnologie', 'it'],
      EN: ['ict', 'information and communication technology', 'it'],
    },
  },
  {
    key: 'outsourcing',
    canonical: { DE: 'Auslagerung', EN: 'outsourcing' },
    variants: {
      DE: ['auslagerung', 'outsourcing', 'fremdvergabe'],
      EN: ['outsourcing', 'externalisation', 'externalization'],
    },
  },
  {
    key: 'third_party',
    canonical: { DE: 'Drittpartei', EN: 'third party' },
    variants: {
      DE: ['drittpartei', 'drittanbieter', 'dritte partei', 'drittdienstleister'],
      EN: ['third party', 'third-party', 'external provider', 'external party'],
    },
  },
  {
    key: 'control',
    canonical: { DE: 'Kontrolle', EN: 'control' },
    variants: {
      DE: ['kontrolle', 'steuerung', 'kontrollmaßnahme'],
      EN: ['control', 'safeguard', 'countermeasure'],
    },
  },
  {
    key: 'risk_appetite',
    canonical: { DE: 'Risikoappetit', EN: 'risk appetite' },
    variants: {
      DE: ['risikoappetit', 'risikobereitschaft', 'risikoneigung'],
      EN: ['risk appetite', 'risk tolerance'],
    },
  },
  {
    key: 'ai_system',
    canonical: { DE: 'KI-System', EN: 'AI system' },
    variants: {
      DE: ['ki-system', 'ai-system', 'system der künstlichen intelligenz'],
      EN: ['ai system', 'artificial intelligence system'],
    },
  },
  {
    key: 'gpai',
    canonical: { DE: 'GPAI', EN: 'GPAI' },
    variants: {
      DE: ['gpai', 'ki mit allgemeinem verwendungszweck', 'allzweck-ki'],
      EN: ['gpai', 'general-purpose ai', 'general purpose ai'],
    },
  },
  {
    key: 'ai_literacy',
    canonical: { DE: 'KI-Kompetenz', EN: 'AI literacy' },
    variants: {
      DE: ['ki-kompetenz', 'ki-kenntnisse', 'ki-grundkompetenz'],
      EN: ['ai literacy', 'ai competence', 'ai proficiency'],
    },
  },
];
