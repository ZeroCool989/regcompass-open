# Quality Check — EU AI Act Knowledge Base

> **Status: RESOLVED** — All P1/P2/P3 issues listed below were addressed in the primary-source rebuild on 2026-05-19 (68 entries, since merged into `lib/kb/requirements.json`; the rebuild artifact is archived as `docs/archive/eu_ai_act_complete.json`). This document is retained for audit trail only.

**Datum:** 2026-05-19
**Quelle (Primärtext):** Verordnung (EU) 2024/1689 (Amtsblatt L, 12.7.2024)
**Geprüfte Datei:** `lib/kb/requirements.json` (25 EU_AI_ACT Einträge — **alte Version vor Rebuild**)
**Methode:** Abgleich gegen Trainingswissen des Gesetzestexts (EUR-Lex WAF-geschützt, kein Live-Abruf möglich)
**Rebuild-Ergebnis:** 68 Einträge aus Primärquelle, alle systematischen Fehler behoben (S1: enforcement korrigiert, S2: financialSectorGuidance separiert, S3: Inhalte aus Gesetzestext extrahiert)

---

## Systematische Fehler (betreffen ALLE oder die meisten Einträge)

### S1: enforcementConsequence FALSCH bei 24 von 25 Einträgen (P1)

**Alle** Einträge zeigen `"Fines up to EUR 35M or 7% global annual turnover (Art. 99)"`.
Dies ist **nur** korrekt für Art. 5 (verbotene Praktiken).

Die tatsächlichen Bußgeldstufen nach Art. 99:
| Stufe | Betrag | Gilt für |
|-------|--------|----------|
| Art. 99(3) | EUR 35M oder 7% | **Nur** Art. 5 (verbotene Praktiken) |
| Art. 99(4) | EUR 15M oder 3% | Alle anderen Pflichten (Art. 8-17, 20-21, 25-27, 53, 55, 72 etc.) |
| Art. 99(5) | EUR 7.5M oder 1% | Falsche/irreführende Angaben an Behörden |

**Betroffene Einträge:** Alle außer R-AIACT-005. Jeder Eintrag braucht die korrekte Stufe.

### S2: Finanzsektor-Kommentare im "body"-Feld vermischt (P2)

Fast jeder Eintrag endet mit einem redaktionellen Kommentar wie "For financial institutions..." oder Verweisen auf DORA, MaRisk, FINMA. Diese sind **nicht** im Gesetzestext und sollten in ein separates Feld (z.B. `financialSectorGuidance`) verschoben oder klar als Editorial gekennzeichnet werden.

Besonders problematisch: **FINMA-Verweise** in EU-Verordnungseinträgen (FINMA ist Schweizer Aufsicht, nicht EU).

### S3: Alle Einträge sind Zusammenfassungen, keine wortlautgetreuen Texte (P3)

Design-Entscheidung, aber reduziert die rechtliche Verlässlichkeit. Für ein Compliance-Tool sollte dies bewusst sein.

---

## Einzelprüfung je Eintrag

| Datei | Artikel | A: Vollständig | B: Wortlaut | C: Erfunden | D: Frontmatter | Priorität | Aufgabe |
|-------|---------|----------------|-------------|-------------|----------------|-----------|---------|
| R-AIACT-003 | Art. 3 | ⚠️ Nur 4 von 68 Definitionen | ⚠️ Art. 3(3): "GPAI model" fehlt; Art. 3(8): "product manufacturer" fehlt | ✅ | ✅ | P2 | Definitionen ergänzen: 3(3) um GPAI model, 3(8) um product manufacturer; weitere compliance-kritische Definitionen hinzufügen |
| R-AIACT-005 | Art. 5 | ⚠️ Art. 5(2)-(8) komplett fehlend; Art. 5(1)(c)(i)(ii) fehlt; Art. 5(1)(h)(i)(ii)(iii) fehlt | ⚠️ Beginnt mit "Financial institutions" statt allgemeingültiger Formulierung; 5(1)(d) unvollständig | ❌ "Commission Guidelines C(2025) 5052" nicht verifizierbar; Art. 5(1)(d) FALSCH mit Kreditwürdigkeit verknüpft — Art. 5(1)(d) betrifft Straftatenvorhersage, NICHT Kredite | ⚠️ enforcement korrekt (35M/7%) für Art. 5 | **P1** | (1) Commission Guidelines Referenz verifizieren/entfernen (2) FALSCHE Art. 5(1)(d)-Kreditwürdigkeitsverknüpfung entfernen (3) Art. 5(2)-(8) ergänzen (4) Sektorspezifische Einleitung entfernen |
| R-AIACT-006 | Art. 6 + Annex III | ⚠️ Art. 6(3) vier Ausnahmebedingungen (a)-(d) fehlen; Art. 6(4)-(8) fehlen; Profiling-Klausel fehlt; Annex III 5(c)(d) fehlen | ⚠️ Art. 6(1) "beide Bedingungen" nicht klar; Art. 6(3) "notify authorities" ist FALSCH → korrekt: "dokumentieren und registrieren gem. Art. 49(2)" | ⚠️ "notify authorities" existiert nicht in Art. 6(3); Annex III 5(a) falsch als "financial services broadly" dargestellt; Fraud-Detection-Ausnahme falsch bei 5(a) statt 5(b) | ⚠️ enforcement falsch | **P1** | (1) Art. 6(3)(a)-(d) Ausnahmen ergänzen (2) "notify authorities" → "document and register" (3) Profiling-Klausel ("always high-risk where profiling") (4) Annex III 5(c) Insurance, 5(d) Emergency (5) Fraud-Detection-Ausnahme zu 5(b) korrigieren (6) enforcement → 15M/3% |
| R-AIACT-008 | Art. 8 | ✅ | ⚠️ Art. 8(2) FALSCH beschrieben — betrifft Produktkonformität mit Harmonisierungsrecht, nicht "intended purpose and risk management" | ⚠️ Art. 8(2) Beschreibung gibt falsche Rechtsfolge wieder | ⚠️ enforcement falsch | P2 | (1) Art. 8(2) korrigieren: Harmonisierungsrecht-Überlappung (2) enforcement → 15M/3% |
| R-AIACT-009 | Art. 9 | ⚠️ Art. 9(3)(6)(8)(9)(10) fehlen; nur 5 von 10 Absätzen abgedeckt | ⚠️ Absatznummerierung SYSTEMATISCH FALSCH: KB "9(4)" = eigentlich 9(5); KB "9(5)" = eigentlich 9(6)/(7); KB "9(7)" = eigentlich 9(8) | ⚠️ Falsche Absatzverweise erzeugen irreführende Rechtsreferenzen | ⚠️ enforcement falsch | **P1** | (1) DRINGEND: Absatznummerierung korrigieren (2) Art. 9(3)(6)(8)(9)(10) ergänzen (3) Art. 9(9) Minderjährige/verletzliche Gruppen besonders relevant für Finanzsektor (4) enforcement → 15M/3% |
| R-AIACT-010 | Art. 10 | ⚠️ Art. 10(1) Scoping-Klausel fehlt (nur training-basierte Systeme); Art. 10(4) geografischer Kontext fehlt; Art. 10(6) Nicht-Training-Systeme fehlt; Art. 10(2)(h) fehlt bzw. falsch als (g) nummeriert | ⚠️ Unterpunkt-Buchstaben falsch: (f)/(g)/(h) verschoben; Art. 10(5) hat 6 Bedingungen, nicht nur "appropriate safeguards" | ⚠️ "comprehensive data lineage" als Anforderung dargestellt — steht nicht in Art. 10 | ⚠️ enforcement falsch | P2 | (1) Art. 10(1) Scoping ergänzen (2) Buchstaben (f)(g)(h) korrigieren (3) Art. 10(4)(6) ergänzen (4) Art. 10(5) Bedingungen vollständig (5) enforcement → 15M/3% |
| R-AIACT-011 | Art. 11 | ⚠️ SME-Vereinfachung aus Art. 11(1) fehlt; Art. 11(2) Harmonisierungsrecht fehlt; Art. 11(3) delegierte Rechtsakte fehlt | ✅ | ✅ | ⚠️ enforcement falsch | P3 | (1) SME-Klausel ergänzen (2) Art. 11(2)-(3) ergänzen (3) enforcement → 15M/3% |
| R-AIACT-012 | Art. 12 | ⚠️ Art. 12(2) komplett falsch dargestellt; Art. 12(3) biometrische Logging-Anforderungen fälschlich als allgemein dargestellt | ❌ Art. 12(2) "recognised standards or common specifications" EXISTIERT NICHT in Art. 12 — ERFUNDENER Text | ❌ Art. 12(2) Inhalt ist FABRIZIERT; Biometrie-spezifische Logging-Anforderungen als allgemein dargestellt; FINMA-Verweis in EU-Verordnung | ⚠️ enforcement falsch | **P1** | (1) DRINGEND: Fabrizierten Art. 12(2) Text entfernen — ersetzen mit tatsächlichem Inhalt (Risikoerkennung, Post-Market-Monitoring, Betriebsüberwachung) (2) Art. 12(3) als nur für Annex III 1(a) Biometrie-Systeme kennzeichnen (3) FINMA-Verweis entfernen (4) enforcement → 15M/3% |
| R-AIACT-013 | Art. 13 | ⚠️ Art. 13(3)(b) stark komprimiert — technische XAI-Fähigkeiten, Performance für spezifische Gruppen, Input-Daten fehlen; Art. 13(3)(f) Log-Mechanismen fehlt | ✅ | ✅ | ⚠️ enforcement falsch | P2 | (1) Art. 13(3)(b) Unterpunkte erweitern (2) Art. 13(3)(f) ergänzen (3) enforcement → 15M/3% |
| R-AIACT-014 | Art. 14 | ⚠️ Art. 14(4)(a) Anomalie-/Fehlfunktionserkennung fehlt; Art. 14(4)(b) Qualifikation zu Empfehlungssystemen fehlt | ⚠️ "human-in-the-loop/on-the-loop" ist redaktionell, nicht Verordnungstext | ❌ Art. 14(5) Annex-III-Punkte FALSCH: KB nennt "2, 3(a)" die NICHT in Art. 14(5) stehen; Punkt 8 fehlt. Korrekt: 1(a), 4, 5, 6, 7, 8 | ⚠️ enforcement falsch; category "transparency" statt "human-oversight" | **P1** | (1) DRINGEND: Art. 14(5) Annex-III-Punkte korrigieren — 2 und 3(a) entfernen, Punkt 8 hinzufügen (2) enforcement → 15M/3% (3) category auf "human-oversight" ändern |
| R-AIACT-015 | Art. 15 | ⚠️ Art. 15(3) Feedback-Loop-Klausel fehlt (Bias durch Rückkopplung); Art. 15(5) zu dünn | ⚠️ DORA-Verweis ist redaktionell, nicht Gesetzestext | ⚠️ DORA-Mapping als Anforderung dargestellt — steht nicht in Art. 15 | ⚠️ enforcement falsch | P2 | (1) Art. 15(3) Feedback-Loop-Klausel ergänzen (2) Editorial trennen (3) enforcement → 15M/3% |
| R-AIACT-016 | Art. 16 | ⚠️ KB sagt "twelve obligations" — tatsächlich 13 (a)-(m); Zugänglichkeits-Richtlinie 2019/882 fehlt | ⚠️ Redaktioneller Finanzsektor-Kommentar im Body | ⚠️ "twelve core obligations" — korrekt wären 13 | ⚠️ enforcement falsch | P2 | (1) Anzahl Pflichten auf 13 korrigieren (2) enforcement → 15M/3% |
| R-AIACT-017 | Art. 17 | ⚠️ QMS-Element (l) "resource management" fehlt; Art. 17(1) hat (a)-(l) nicht (a)-(k) | ⚠️ Punkte (e)(h)(i) ungenau | ✅ | ⚠️ enforcement falsch | P2 | (1) Element (l) ergänzen (2) enforcement → 15M/3% |
| R-AIACT-020 | Art. 20 | ✅ | ⚠️ "Model drift" und "data quality degradation" sind redaktionelle Beispiele | ⚠️ Redaktionelle Interpretation im Body | ⚠️ enforcement falsch | P3 | (1) Editorial kennzeichnen (2) enforcement → 15M/3% |
| R-AIACT-021 | Art. 21 | ⚠️ Unterschied zu Art. 73 (Incident Reporting) nicht klar gemacht | ⚠️ FINMA-Verweis in EU-Kontext irreführend | ⚠️ FINMA ist Schweizer Behörde, nicht EU | ⚠️ enforcement falsch | P2 | (1) Art. 21 vs. Art. 73 Abgrenzung (2) FINMA-Verweis entfernen (3) enforcement → 15M/3% |
| R-AIACT-025 | Art. 25 | ⚠️ Art. 25(3)-(4) fehlen | ⚠️ Art. 25(2) Kooperationspflicht zu dünn beschrieben | ⚠️ "Fine-tuning" redaktionell | ⚠️ enforcement falsch | P2 | (1) Art. 25(3)-(4) ergänzen (2) enforcement → 15M/3% |
| R-AIACT-026 | Art. 26 | ⚠️ Art. 26(3) Input-Daten-Relevanz fehlt; Art. 26(10) DSGVO-DSFA fehlt; Art. 26(11) fehlt; Art. 26(8) "main elements of the decision taken" fehlt | ⚠️ Art. 26(8) unvollständig | ✅ | ⚠️ enforcement falsch | **P1** | (1) Art. 26(3) Input-Daten (2) Art. 26(10) DSGVO Art. 35 DSFA-Link (3) Art. 26(8) vervollständigen (4) enforcement → 15M/3% |
| R-AIACT-027 | Art. 27 | ⚠️ Art. 27(3) Provider-Einbindung fehlt; Art. 27(4) HARD GATE fehlt (kein Einsatz vor FRIA-Abschluss!); Art. 27(5) Meldepflicht an Aufsicht fehlt | ⚠️ Art. 27(2)(f) unvollständig — "complaint mechanisms" fehlt | ✅ | ⚠️ enforcement falsch | **P1** | (1) DRINGEND: Art. 27(4) Hard Gate ergänzen — kritisch für Compliance (2) Art. 27(3)(5) ergänzen (3) enforcement → 15M/3% |
| R-AIACT-049 | Art. 49 | ⚠️ Art. 49(4) fehlt; Update-Pflicht fehlt | ⚠️ "Annex I" Referenz in 49(3) prüfen — evtl. Art. 6(1) | ⚠️ "production deployment" Timing ist redaktionell | ⚠️ enforcement DOPPELT FALSCH: sollte 15M/3% sein, evtl. sogar 7.5M/1% für Info-Pflichten | **P1** | (1) enforcement → 15M/3% (2) Art. 49(4) ergänzen (3) Update-Pflicht ergänzen |
| R-AIACT-050 | Art. 50 | ⚠️ Art. 50(2) technische Qualitätsanforderungen fehlen; Art. 50(3) Kunst/Satire-Ausnahme fehlt; Art. 50(4) "at the latest at the time of first interaction" fehlt | ✅ | ⚠️ Redaktionelle Finanzsektor-Beispiele | ⚠️ enforcement FALSCH: Art. 50 fällt unter 15M/3% | **P1** | (1) enforcement → 15M/3% (2) Art. 50(3) Ausnahmen (3) Art. 50(2) Qualitätsanforderungen |
| R-AIACT-053 | Art. 53 | ⚠️ Art. 53(2) Codes of Practice fehlt; Art. 53(3) Open-Source-Ausnahme KOMPLETT FEHLEND — wichtige Bestimmung; Art. 53(4) Schwellenwert-Ausnahme fehlt | ⚠️ Redaktioneller Finanzsektor-Kommentar | ⚠️ Redaktionell | ⚠️ enforcement falsch | **P1** | (1) Art. 53(3) Open-Source-Ausnahme DRINGEND ergänzen (2) Art. 53(2)(4) ergänzen (3) enforcement → 15M/3% |
| R-AIACT-055 | Art. 55 | ⚠️ Art. 55(2) Codes of Practice fehlt; Art. 55(3) AI-Office-Informationspflicht fehlt | ⚠️ Redaktionell | ⚠️ Redaktioneller Kommentar adressiert downstream users — Art. 55 adressiert nur Provider | ⚠️ enforcement falsch; riskTier "high" fragwürdig (sollte "gpai-systemic" sein) | P2 | (1) Art. 55(2)-(3) ergänzen (2) riskTier prüfen (3) enforcement → 15M/3% |
| R-AIACT-072 | Art. 72 | ⚠️ VO (EU) 2019/1020 Referenz fehlt | ⚠️ "Drift detection" ist redaktionell, nicht im Gesetzestext | ⚠️ "Drift detection" und "deployer feedback" redaktionell | ⚠️ enforcement falsch; verified=false (einziger) | P2 | (1) enforcement → 15M/3% (2) VO 2019/1020 Referenz (3) Editorial trennen |
| R-AIACT-078 | Art. 78-84 | ⚠️ Einzelartikel 79-84 nicht separat beschrieben; Art. 79 FALSCH zugeordnet — Finanzaufsicht ist Art. 74(8), nicht Art. 79 | ⚠️ Art. 79 Inhalt falsch zugeordnet; FINMA-Verweis (nicht EU) | ❌ "Art. 79 provides that the authority responsible for financial services supervision shall serve as the market surveillance authority" — dies steht in Art. 74(8), NICHT Art. 79. Art. 79 betrifft nationale Risikobewertung. FALSCHE Artikelzuordnung | ⚠️ enforcement falsch; audience nur "authority" obwohl Provider/Deployer betroffen | **P1** | (1) Art. 79 → Art. 74(8) korrigieren (2) FINMA-Verweis entfernen (3) Einzelartikel 79-84 aufschlüsseln (4) enforcement anpassen |
| R-AIACT-ANX4 | Annex IV | ⚠️ Sehr dünn für einen detaillierten Anhang; Datenherkunft, Annotation, Qualitätsmaßnahmen fehlen; Post-Market-Monitoring-Plan fehlt; "copy of EU declaration of conformity" fehlt | ⚠️ Stark zusammengefasst | ⚠️ MaRisk/FINMA-Verweise redaktionell — Annex IV erwähnt weder MaRisk noch FINMA | ⚠️ enforcement falsch; verified=false | **P1** | (1) Annex IV deutlich erweitern (2) Datenherkunft/-qualität (3) Post-Market-Plan (4) Editorial trennen (5) enforcement → 15M/3% |

---

## Zusammenfassung

### Prioritäts-Übersicht

| Priorität | Anzahl | Einträge |
|-----------|--------|----------|
| **P1** | **12** | R-AIACT-005, R-AIACT-006, R-AIACT-009, R-AIACT-012, R-AIACT-014, R-AIACT-026, R-AIACT-027, R-AIACT-049, R-AIACT-050, R-AIACT-053, R-AIACT-078, R-AIACT-ANX4 |
| **P2** | **10** | R-AIACT-003, R-AIACT-008, R-AIACT-010, R-AIACT-013, R-AIACT-015, R-AIACT-016, R-AIACT-017, R-AIACT-021, R-AIACT-025, R-AIACT-055, R-AIACT-072 |
| **P3** | **3** | R-AIACT-011, R-AIACT-020 |

### Top 5 Kritischste Fixes

1. **enforcementConsequence bei 24 Einträgen falsch** — Alle zeigen 35M/7%, aber nur Art. 5 fällt in diese Stufe. Korrekte Stufen: 15M/3% (meiste) bzw. 7.5M/1% (Info-Pflichten). **Systemweiter Fix nötig.**

2. **R-AIACT-012 (Art. 12): FABRIZIERTER Inhalt** — "logging capabilities shall conform to recognised standards or common specifications" existiert NICHT in Art. 12. Biometrie-spezifische Logging-Anforderungen werden fälschlich als allgemeingültig dargestellt.

3. **R-AIACT-005 (Art. 5): FALSCHE Verknüpfung** — Art. 5(1)(d) betrifft Straftatenvorhersage, NICHT Kreditwürdigkeit. Die KB verknüpft dies fälschlich mit Krediten. Unverifizierbarer Commission Guidelines Verweis.

4. **R-AIACT-009 (Art. 9): Absatznummerierung SYSTEMATISCH FALSCH** — Inhalte sind 1-2 Absätze verschoben. Wer nach "Art. 9(4)" sucht, findet die falsche Bestimmung.

5. **R-AIACT-014 (Art. 14): FALSCHE Annex-III-Punkte** — Art. 14(5) referenziert NICHT Punkte 2 und 3(a). Punkt 8 fehlt. Rechtlich relevanter Fehler bei Human-Oversight-Pflichten.

### Hinweis zur Methodik

Die EUR-Lex URL (https://eur-lex.europa.eu/legal-content/DE/TXT/HTML/?uri=OJ:L_202401689) war durch eine AWS WAF geschützt und konnte nicht automatisiert abgerufen werden. Die Prüfung erfolgte gegen Trainingswissen des vollständigen Gesetzestexts der VO (EU) 2024/1689 (Amtsblatt L, 12.7.2024). **Empfehlung:** P1-Einträge zusätzlich manuell gegen die EUR-Lex Originalfassung verifizieren.
