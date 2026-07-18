/**
 * German display labels for KB enum values. Use these whenever a raw enum
 * value (audience, category, riskTier, …) is rendered to the user.
 *
 * The enum strings themselves stay English because they are stable
 * identifiers (URLs, filters, JSON keys). Only the *display* changes.
 */

export const AUDIENCE_LABELS: Record<string, string> = {
  all: 'Alle Akteure',
  provider: 'Anbieter',
  deployer: 'Betreiber',
  authority: 'Behörde',
  'gpai-provider': 'GPAI-Anbieter',
  importer: 'Importeur',
  distributor: 'Distributor',
  'authorised-representative': 'Bevollmächtigter',
  'financial-entity': 'Finanzunternehmen',
  'ict-third-party-provider': 'IKT-Drittanbieter',
};

export const CATEGORY_LABELS: Record<string, string> = {
  governance: 'Governance',
  'risk-management': 'Risikomanagement',
  data: 'Daten',
  transparency: 'Transparenz',
  security: 'Sicherheit',
  monitoring: 'Überwachung',
  documentation: 'Dokumentation',
  'third-party': 'Drittanbieter',
  rights: 'Rechte',
  'prohibited-practices': 'Verbotene Praktiken',
  'incident-reporting': 'Vorfallmeldung',
  'resilience-testing': 'Resilienz-Tests',
  'third-party-risk': 'Drittanbieter-Risiko',
  enforcement: 'Durchsetzung',
  cooperation: 'Zusammenarbeit',
  cybersecurity: 'Cybersicherheit',
  scope: 'Geltungsbereich',
  definitions: 'Definitionen',
  classification: 'Klassifizierung',
  conformity: 'Konformität',
  'conformity-assessment': 'Konformitätsbewertung',
  standards: 'Standards',
  registration: 'Registrierung',
  database: 'Datenbank',
  'human-oversight': 'Menschliche Aufsicht',
  'record-keeping': 'Aufzeichnungspflicht',
  'quality-management': 'Qualitätsmanagement',
  'post-market-monitoring': 'Post-Market-Monitoring',
  'provider-obligations': 'Anbieter-Pflichten',
  'deployer-obligations': 'Betreiber-Pflichten',
  'importer-obligations': 'Importeur-Pflichten',
  'distributor-obligations': 'Distributor-Pflichten',
  'authorised-representatives': 'Bevollmächtigte',
  'value-chain': 'Wertschöpfungskette',
  'corrective-actions': 'Korrekturmassnahmen',
  'market-surveillance': 'Marktaufsicht',
  'codes-of-conduct': 'Verhaltenskodizes',
  penalties: 'Sanktionen',
  'fundamental-rights': 'Grundrechte',
  'rights-and-remedies': 'Rechte und Rechtsbehelfe',
  'innovation-support': 'Innovationsförderung',
  'gpai-obligations': 'GPAI-Pflichten',
  'gpai-governance': 'GPAI-Governance',
  'gpai-classification': 'GPAI-Klassifizierung',
  'data-governance': 'Daten-Governance',
  testing: 'Tests',
  requirements: 'Anforderungen',
  'transitional-provisions': 'Übergangsbestimmungen',
  'application-timeline': 'Anwendungszeitplan',
};

export const RISK_TIER_LABELS: Record<string, string> = {
  prohibited: 'Verboten',
  'high-risk': 'Hochrisiko',
  'limited-risk': 'Begrenztes Risiko',
  'minimal-risk': 'Minimales Risiko',
  all: 'Alle Risikoklassen',
  gpai: 'GPAI',
  'gpai-systemic': 'GPAI (systemisch)',
};

export const BINDING_LEVEL_LABELS: Record<string, string> = {
  mandatory: 'Verpflichtend',
  supervisory_expectation: 'Aufsichtsrechtliche Erwartung',
  best_practice: 'Best Practice',
};

export const RELEVANCE_LABELS: Record<string, string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

export const PRIORITY_LABELS: Record<string, string> = {
  critical: 'Kritisch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

export const COMPLEXITY_LABELS: Record<string, string> = {
  low: 'niedrige Komplexität',
  medium: 'mittlere Komplexität',
  high: 'hohe Komplexität',
};

/**
 * Look up a label with graceful fallback to the raw value if no German
 * translation is registered (helps surface missing entries during dev
 * without crashing the UI).
 */
export function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
