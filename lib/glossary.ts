export type GlossaryEntry = {
  de: string;
  en: string;
  category: 'regulation' | 'institution' | 'concept' | 'acronym';
};

export const GLOSSARY: Record<string, GlossaryEntry> = {
  'EU AI Act': { de: 'Europäische Verordnung zur Regulierung von KI-Systemen (VO (EU) 2024/1689). Klassifiziert KI in Risikostufen und stellt Anforderungen an Hochrisiko-Systeme.', en: 'European regulation for AI systems (Regulation (EU) 2024/1689).', category: 'regulation' },
  'DORA': { de: 'Digital Operational Resilience Act — EU-Verordnung zur digitalen operationellen Resilienz im Finanzsektor. Regelt IKT-Risikomanagement, Vorfallmeldung und Drittanbieter-Aufsicht.', en: 'Digital Operational Resilience Act for the financial sector.', category: 'regulation' },
  'NIS2': { de: 'Network and Information Security Directive 2 — EU-Richtlinie zur Cybersicherheit. Definiert Mindeststandards für Netz- und Informationssicherheit.', en: 'Network and Information Security Directive 2.', category: 'regulation' },
  'GDPR': { de: 'General Data Protection Regulation / Datenschutz-Grundverordnung (DSGVO) — EU-Verordnung zum Schutz personenbezogener Daten.', en: 'General Data Protection Regulation.', category: 'regulation' },
  'DSGVO': { de: 'Datenschutz-Grundverordnung — EU-Verordnung zum Schutz personenbezogener Daten (englisch: GDPR).', en: 'German name for GDPR.', category: 'regulation' },
  'DSA': { de: 'Digital Services Act — EU-Verordnung für digitale Dienste. Regelt Haftung und Sorgfaltspflichten von Online-Plattformen.', en: 'Digital Services Act.', category: 'regulation' },
  'Data Act': { de: 'EU-Datengesetz (VO (EU) 2023/2854) — regelt den Zugang zu und die Nutzung von Daten, die durch vernetzte Produkte erzeugt werden.', en: 'EU Data Act on data access and use.', category: 'regulation' },
  'revDSG': { de: 'Revidiertes Schweizer Datenschutzgesetz (DSG), in Kraft seit 1. September 2023. Schweizer Pendant zur DSGVO.', en: 'Revised Swiss Data Protection Act.', category: 'regulation' },
  'MaRisk': { de: 'Mindestanforderungen an das Risikomanagement — BaFin-Rundschreiben mit Vorgaben für das Risikomanagement deutscher Banken.', en: 'Minimum Requirements for Risk Management (German banks).', category: 'regulation' },
  'BAIT': { de: 'Bankaufsichtliche Anforderungen an die IT — BaFin-Rundschreiben das MaRisk AT 7.2 für IT konkretisiert. Wird durch DORA abgelöst.', en: 'Supervisory Requirements for IT in Financial Institutions.', category: 'regulation' },
  'BDSG': { de: 'Bundesdatenschutzgesetz — deutsches Datenschutzgesetz, ergänzt die DSGVO national.', en: 'German Federal Data Protection Act.', category: 'regulation' },
  'BSIG': { de: 'BSI-Gesetz — Gesetz über das Bundesamt für Sicherheit in der Informationstechnik. Deutsche NIS2-Umsetzung.', en: 'German IT Security Act (BSI Act).', category: 'regulation' },

  'FINMA': { de: 'Eidgenössische Finanzmarktaufsicht — Schweizer Aufsichtsbehörde für Banken, Versicherungen und Finanzmarktinfrastrukturen.', en: 'Swiss Financial Market Supervisory Authority.', category: 'institution' },
  'BaFin': { de: 'Bundesanstalt für Finanzdienstleistungsaufsicht — Deutsche Finanzaufsichtsbehörde.', en: 'German Federal Financial Supervisory Authority.', category: 'institution' },
  'BSI': { de: 'Bundesamt für Sicherheit in der Informationstechnik — Deutsche Behörde für Cybersicherheit.', en: 'German Federal Office for Information Security.', category: 'institution' },
  'EDÖB': { de: 'Eidgenössischer Datenschutz- und Öffentlichkeitsbeauftragter — Schweizer Datenschutzaufsicht.', en: 'Swiss Federal Data Protection Commissioner.', category: 'institution' },

  'DSFA': { de: 'Datenschutz-Folgenabschätzung — Pflichtanalyse vor Datenverarbeitungen mit hohem Risiko (GDPR Art. 35, revDSG Art. 22). Bewertet Risiken und definiert Schutzmassnahmen.', en: 'Data Protection Impact Assessment (DPIA).', category: 'concept' },
  'DPIA': { de: 'Data Protection Impact Assessment — englisch für DSFA. Pflichtanalyse vor risikoreicher Datenverarbeitung.', en: 'Data Protection Impact Assessment.', category: 'acronym' },
  'FRIA': { de: 'Fundamental Rights Impact Assessment — Grundrechte-Folgenabschätzung nach EU AI Act Art. 27 für Betreiber von Hochrisiko-KI.', en: 'Fundamental Rights Impact Assessment under EU AI Act.', category: 'acronym' },
  'Hochrisiko-KI': { de: 'KI-System das unter EU AI Act Anhang III fällt — z.B. Kreditscoring, biometrische Erkennung, Personalauswahl. Erfordert Konformitätsbewertung und umfassende Dokumentation.', en: 'High-risk AI system under EU AI Act Annex III.', category: 'concept' },
  'Profiling': { de: 'Automatisierte Verarbeitung personenbezogener Daten zur Bewertung persönlicher Aspekte (Arbeitsleistung, Kreditwürdigkeit, Gesundheit, Verhalten etc.).', en: 'Automated processing to evaluate personal aspects.', category: 'concept' },
  'Konformitätsbewertung': { de: 'Verfahren zur Prüfung ob ein Hochrisiko-KI-System alle EU-AI-Act-Anforderungen erfüllt. Muss vor dem Inverkehrbringen durchgeführt werden.', en: 'Conformity assessment for high-risk AI systems.', category: 'concept' },
  'CE-Kennzeichnung': { de: 'Kennzeichen das bestätigt, dass ein KI-System die EU-AI-Act-Anforderungen erfüllt. Pflicht für Hochrisiko-KI vor dem Marktzugang.', en: 'CE marking confirming EU AI Act compliance.', category: 'concept' },
  'IKT': { de: 'Informations- und Kommunikationstechnologie — Oberbegriff für IT-Systeme und -Infrastruktur im regulatorischen Kontext (DORA, FINMA).', en: 'Information and Communication Technology (ICT).', category: 'acronym' },
  'IKS': { de: 'Internes Kontrollsystem — Gesamtheit aller Überwachungs- und Kontrollmechanismen einer Organisation.', en: 'Internal Control System.', category: 'acronym' },
  'BCM': { de: 'Business Continuity Management — Massnahmen zur Sicherstellung der Geschäftsfortführung bei Störungen und Notfällen.', en: 'Business Continuity Management.', category: 'acronym' },
  'BCP': { de: 'Business Continuity Plan — konkreter Notfallplan für die Fortführung kritischer Geschäftsprozesse.', en: 'Business Continuity Plan.', category: 'acronym' },
  'XAI': { de: 'Explainable AI — Methoden zur Erklärbarkeit von KI-Entscheidungen (z.B. SHAP, LIME). Von FINMA 08/2024 erwartet.', en: 'Explainable AI methods.', category: 'acronym' },
  'Rundschreiben': { de: 'Regulatorisches Instrument der FINMA oder BaFin — konkretisiert gesetzliche Anforderungen für beaufsichtigte Institute. Kein Gesetz, aber aufsichtsrechtlich bindend.', en: 'Regulatory circular issued by FINMA or BaFin.', category: 'concept' },
  'Aufsichtsmitteilung': { de: 'Kommunikationsinstrument der FINMA — teilt Beobachtungen und Erwartungen aus Aufsichtstätigkeit mit. Keine Rechtsnorm, aber in der Praxis hoch bindend.', en: 'FINMA supervisory communication.', category: 'concept' },
  'Outsourcing': { de: 'Auslagerung von Funktionen oder Dienstleistungen an Drittanbieter. Reguliert durch FINMA RS 2018/3, MaRisk AT 9, DORA Art. 28-44.', en: 'Outsourcing of functions to third-party providers.', category: 'concept' },
  'KRITIS': { de: 'Kritische Infrastrukturen — Einrichtungen mit hoher Bedeutung für das Gemeinwesen (Energie, Finanzen, Gesundheit etc.). Unterliegen besonderen Cybersicherheitsanforderungen (BSIG, NIS2).', en: 'Critical infrastructure.', category: 'acronym' },
  'Risikotragfähigkeit': { de: 'Fähigkeit eines Instituts, wesentliche Risiken zu tragen ohne die Geschäftsfortführung zu gefährden. MaRisk AT 4.1 Kernkonzept.', en: 'Risk-bearing capacity of a financial institution.', category: 'concept' },
  'Modellrisiko': { de: 'Risiko das entsteht wenn Modelle (inkl. KI) fehlerhafte Ergebnisse liefern oder falsch angewendet werden. MaRisk AT 4.3.5.', en: 'Model risk from faulty or misapplied models.', category: 'concept' },
  'GPAI': { de: 'General Purpose AI — KI-Modelle für allgemeine Zwecke (z.B. GPT, Claude). EU AI Act Kapitel V stellt eigene Anforderungen.', en: 'General Purpose AI models under EU AI Act Chapter V.', category: 'acronym' },
  'Sandbox': { de: 'Regulatorische Sandbox — kontrollierte Testumgebung für innovative Finanzdienstleistungen oder KI-Systeme unter Aufsicht.', en: 'Regulatory sandbox for testing under supervision.', category: 'concept' },
  'TLPT': { de: 'Threat-Led Penetration Testing — bedrohungsbasierte Penetrationstests nach DORA Art. 26-27 für systemrelevante Finanzinstitute.', en: 'Threat-Led Penetration Testing under DORA.', category: 'acronym' },
};

export const GLOSSARY_TERMS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

const CATEGORY_LABELS: Record<GlossaryEntry['category'], string> = {
  regulation: 'Regulierung',
  institution: 'Institution',
  concept: 'Fachbegriff',
  acronym: 'Akronym',
};

export { CATEGORY_LABELS };
