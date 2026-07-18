/**
 * Regression fixture: a large compliance-assessment prompt (9 numbered sections
 * plus an explicit compliance catalogue) representative of the inputs that used
 * to time out in the single-pass pipeline. Triage MUST classify it SECTIONED,
 * and it must run to completion without a user-visible error.
 */
export const COMPLIANCE_FIXTURE_PROMPT = `Analysiere, worauf ein Unternehmen achten muss, wenn FlowDesk zunächst als Open-Source-Lösung über GitHub veröffentlicht wird, später aber potenziell als Enterprise-Anwendung integriert werden soll.

Kontext:

* FlowDesk ist eine React-App mit Node.js und TypeScript.
* Die Lösung soll zunächst als Open Source bereitgestellt werden.
* Später ist eine mögliche Enterprise-Integration bei Kunden denkbar.
* Im Fokus steht insbesondere der Harness: also die Steuerung des Agents, Tool-Nutzung, Kontextmanagement, Guardrails, Berechtigungen, Logging und Governance.

Bitte prüfe strukturiert folgende Bereiche:

1. Open-Source-Veröffentlichung

* Welche Lizenz sollte gewählt werden und welche Auswirkungen hat sie?
* Welche Risiken entstehen durch öffentliche Bereitstellung des Codes?
* Welche Secrets, API Keys, Tokens oder internen Informationen dürfen niemals im Repository enthalten sein?
* Welche Dokumentation ist notwendig, damit externe Nutzer die Lösung sicher verstehen?
* Welche Haftungsausschlüsse, Security Notes und Contribution Guidelines sollten ergänzt werden?

2. Architektur und Codebasis

* Welche Teile der Lösung sind Frontend, Backend, Agent Logic und Harness?
* Welche Komponenten sind kritisch für Enterprise-Nutzung?
* Wo entstehen technische Abhängigkeiten durch Node.js, TypeScript, React, APIs oder externe Modelle?
* Welche Bereiche müssen modular sein, damit sie später enterprise-fähig erweitert werden können?

3. Agent und Harness

* Was darf der Agent aktuell tun?
* Welche Tools darf er nutzen?
* Wie werden Tool-Aufrufe kontrolliert?
* Gibt es Rollen, Berechtigungen oder Approval-Flows?
* Wie wird verhindert, dass der Agent ungewollte Aktionen ausführt?
* Gibt es Audit Logs, Nachvollziehbarkeit und Human-in-the-loop-Kontrollen?
* Welche Funktionen sind out of the box vorhanden und welche benötigen Custom Development?

4. Security

* Authentifizierung und Autorisierung
* Rollen- und Rechtekonzept
* Secrets Management
* API-Sicherheit
* Input Validation
* Prompt Injection Schutz
* Zugriff auf Kundendaten
* Logging ohne sensible Daten
* Dependency Scanning
* Vulnerability Management
* Secure Deployment Pipeline

5. Datenschutz und Datenmanagement

* Welche Daten werden verarbeitet?
* Werden personenbezogene Daten verarbeitet?
* Wo werden Daten gespeichert?
* Werden Daten an externe AI-Modelle oder APIs gesendet?
* Gibt es Data Retention, Löschkonzepte und Zugriffskontrollen?
* Welche Anforderungen aus GDPR / DSGVO und Schweizer Datenschutzrecht sind relevant?

6. Enterprise-Integration

* Welche Anforderungen entstehen bei Integration in eine Unternehmensumgebung?
* SSO / IAM / Azure AD / Entra ID
* Rollenmodell
* Mandantenfähigkeit
* Logging und Monitoring
* Auditierbarkeit
* Betriebsmodell
* SLA / Support
* Incident Management
* Change Management
* Release Management
* Backup / Recovery
* Exit-Strategie

7. Regulatorik und Governance

* Welche Anforderungen können aus EU AI Act, DORA, DSGVO, FINMA, MaRisk oder internen Compliance-Vorgaben relevant sein?
* Ist FlowDesk eher ein AI-System, ein Agent-Harness, ein Entwickler-Tool oder ein Compliance-relevantes System?
* Welche Governance-Dokumente wären für Enterprise-Kunden nötig?
* Welche Kontrollen braucht man für Modellrisiko, Drittparteienrisiko, ICT-Risiko und operationelles Risiko?

8. Drittanbieter und externe Abhängigkeiten

* Welche externen Services, APIs, Modelle oder Libraries werden genutzt?
* Welche Risiken entstehen dadurch?
* Sind Subdienstleister relevant?
* Gibt es Vendor Risk Management Anforderungen?
* Müssen Kunden eigene Modellprovider konfigurieren können?

9. Compliance Catalogue
   Erstelle am Ende einen Compliance-Katalog mit:

* Kontrollbereich
* Risiko
* Anforderung
* Empfohlene Kontrolle
* Verantwortlichkeit
* Open-Source-Relevanz
* Enterprise-Relevanz
* Priorität: kritisch / hoch / mittel / niedrig

Ziel:
Das Ergebnis soll dem Unternehmen helfen zu verstehen, welche technischen, regulatorischen, sicherheitsbezogenen und governance-relevanten Punkte vor einer Open-Source-Veröffentlichung und vor einer späteren Enterprise-Integration von FlowDesk berücksichtigt werden müssen.

Bitte antworte strukturiert, praxisnah und mit konkreten Empfehlungen.`;
