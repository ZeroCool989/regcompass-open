# Verification Report

**Date:** 2026-05-25 (spot-check addendum: 2026-07-17)
**Method:** Manual cross-check of `lib/kb/requirements.json` against primary regulatory source documents in `docs/source/`
**Verified by:** manual-source-verification-2026-05-25

## Summary

| Metric | Count |
|--------|-------|
| Total requirements | 265 |
| Total controls | 160 |
| Total crosswalk entries | 15 |
| Total regulations | 19 |
| Manually source-verified entries | 92 |
| Dual-agent source-verified entries (2026-07-17 sweep) | 172 |
| Automated-crosscheck only (pending) | 1 (ISO 23894) |

## Per-Regulation Verification Status

| Regulation | Entries | Verifier | Verification depth |
|-----------|---------|----------|--------------------|
| EU AI Act | 68 | dual-agent-source-verification (2026-07-17); 2 entries manual (2026-07-17) | Two independent verification passes per entry against `eu_ai_act_DE.txt`; 12 substantive + 41 minor corrections applied |
| DORA | 61 | dual-agent-source-verification (2026-07-17) | Two independent verification passes per entry against `eu_dora_act_DE.txt`; 7 substantive + 33 minor corrections applied |
| NIS2 | 45 | dual-agent-source-verification (2026-07-17); 1 entry manual (2026-07-17) | Two independent verification passes per entry against `eu_nis2_act_DE.txt`; 5 substantive + 26 minor corrections applied |
| GDPR | 15 | manual-source-verification (2026-05-25) | Article-by-article cross-check against `eu_GDPR_act_DE.txt`; 4 substantive fixes + 1 new entry (Art. 36) |
| revDSG | 11 | manual-source-verification (2026-05-25) | Cross-check against `revDSG_DE.txt` |
| FINMA 08/2024 | 8 | manual-source-verification (2026-05-25) | Cross-check against `FINMA 082024_DE.txt` |
| FINMA RS 2023/1 | 8 | manual-source-verification (2026-05-25) | Cross-check against `FINMA RS 2023_1_DE.txt` |
| FINMA RS 2018/3 | 7 | manual-source-verification (2026-05-25) | Cross-check against `FINMA RS 2018_3_DE.txt` |
| DSA | 6 | manual-source-verification (2026-05-25) | Cross-check against `eu_dsa_act_DE.txt` |
| MaRisk | 6 | manual-source-verification (2026-05-25) | Deep QC against `MaRisk_DE.txt`; 3 substantive fixes + 3 new entries (AT 3, 7.2, 8.1) |
| BAIT | 5 | manual-source-verification (2026-05-25) | Deep QC against `BAIT_DE.txt`; 3 substantive fixes + 2 new entries (Kap. 3 IRM, Kap. 8 IT-Betrieb); DORA exemption since 2025-01-17 corrected |
| Data Act | 5 | manual-source-verification (2026-05-25) | Cross-check against `eu_data_act_DE.txt` |
| BDSG | 4 | manual-source-verification (2026-05-25) | Cross-check against `Bundesdatenschutzgesetz (BDSG)_DE.txt` |
| BSIG | 4 | manual-source-verification (2026-05-25) | Cross-check against `BSI-Gesetz - BSIG_DE.txt` |
| Product Liability | 4 | manual-source-verification (2026-05-25) | Cross-check against `eu_product_liability_directive_DE.txt` |
| NIST AI RMF | 4 | manual-source-verification (2026-05-25) | Deep QC against `nist.ai.100-1_DE.txt`; 1 fix (DEIA in summary). All 13 MEASURE 2.x sub-categories verified verbatim |
| ISO 42001 | 2 | manual-source-verification (2026-05-25) | Deep QC against `ISO-42001_DE.txt`; Clause 8 and Annex A summary corrected, harmonized-standard editorial claim removed |
| ISO 42005 | 1 | manual-source-verification (2026-05-25) | Deep QC against `Iso-42005-2024-Dis-Standard_DRAFT_DE.txt`; no content fixes — entry already substantively correct. DIS draft status |
| ISO 23894 | 1 | automated-crosscheck-v1 | **Pending manual QC pass** |

## Manual QC Sessions Conducted in May 2026

The May 2026 manual verification sweep covered every regulation except ISO 23894 (1 entry, separate task). Each session followed the same protocol:

1. Read the full primary source document in `docs/source/`
2. Cross-check every paragraph/clause/Tz. reference in each KB entry against the source
3. Verify summaries, body text, articles, tags against source content
4. Identify hallucinated, mis-mapped, or out-of-scope claims
5. Apply fixes and update `verifiedBy` metadata
6. Add new AI-relevant entries where the source had clear gaps in KB coverage

Each session was committed atomically with the pattern `fix(kb): <regulation> QC — X fixes, Y new entries`.

## Notable Findings from the May 2026 Sweep

- **MaRisk and BAIT** had systematic Tz.-number hallucinations in 3 entries each — content described real regulatory requirements but with completely wrong Tz. references. Fixed by rewriting body text from verified source.
- **BAIT** sunset date was incorrectly listed as "end of 2026" in multiple entries — actual: DORA-covered institutes have been exempted from BAIT since 17 January 2025 per Vorbemerkung Tz. 1.
- **GDPR Art. 36 Prior Consultation** was missing entirely from the KB despite being the operational hand-off from Art. 35 DPIA. Added as R-GDPR-036.
- **MaRisk ID typo** (`R-MARIK-*` vs `R-MARISK-*`) fixed across all 6 entries with `app/page.tsx` defensive mapping cleaned up.
- **Crosswalk dangling references** identified across CW-006, CW-007, CW-009, CW-010, CW-011, CW-012, CW-014 referencing non-existent IDs (R-BAIT-001/002/005, R-BSIG-001/002, R-REVDSG-001/002, R-BDSG-001, R-AIACT-009-5). Cleaned up.

## July 2026 Spot-Check Addendum (2026-07-17)

Two independent reviewers sampled 20 disjoint bulk-extracted entries (EU AI Act, DORA, NIS2) and cross-checked article numbers, deadlines, fine amounts, and summary claims against the primary sources in `docs/source/`. Body texts were accurate in all 20 entries. Two summary-level errors were found and fixed (EN + DE), and both entries were marked verified (`review-spot-check-2026-07-17`):

- **R-AIACT-073** — summary claimed "immediate for death"; Art. 73(4) requires reporting immediately upon establishing/suspecting the causal link, **at the latest 10 days** after awareness (`eu_ai_act_DE.txt`, "spätestens jedoch zehn Tage").
- **R-NIS2-034** — summary said fines "up to" EUR 10M/2%; Art. 34(4)–(5) sets a **floor on the national maximum** ("Höchstbetrag von mindestens"), not a cap.

A milder summary deviation on R-NIS2-028 (72h "grant access" vs. "answer the request") is queued for the full sweep. Note: the previous count of 91 manually verified entries was off by one (actual: 90, see `docs/governance/MIGRATION_NOTES.md`); with the two entries above the correct total is **92**.

## Outstanding Work

1. **ISO 23894 deep QC** — 1 entry still on `automated-crosscheck-v1`; needs source cross-check against `docs/source/` material if available.
2. **EU AI Act, DORA, NIS2 spot-checks** — bulk-extracted from primary source on 2026-05-19 with consistent `primary-source-extraction` markers, but have not received the same depth of manual paragraph-level review as the May 2026 manual sweep. Recommended for spot-check of critical articles.
3. **New crosswalk topics** — six new AI-relevant entries added in May 2026 (R-MARISK-003/-072/-081, R-BAIT-003/-008, R-GDPR-036) are candidates for inclusion in existing crosswalk topics like CW-005 (Documentation) or CW-007 (Testing).

## 2026-07-17 Dual-Pass Agent Sweep (EU AI Act, DORA, NIS2)

All 172 bulk-extracted entries received two **independent** verification passes by separate AI agents (neither saw the other's results), each required to locate the cited article in the German primary source (`docs/source/`) and check every claim — actors, deadlines, thresholds, scope, penalty provisions — against the source text only. The second pass was explicitly adversarial. Severity disagreements were re-verified by a third adjudicating agent. Per-entry records (verdicts of both passes, evidence, corrected fields) are in `docs/governance/verification-records/2026-07-17-bulk-sweep.jsonl`.

**Results:** 48 accurate · 100 minor deviations · 24 substantive errors · 0 unverifiable. 124 entries corrected (352 field updates). Every swept entry now carries `verificationMethod: dual-agent-source-verification` with `verifiedAt: 2026-07-17` and a `verifiedBy` pointer to the per-entry records file.

### Substantive corrections (claims a client could have been misled by)

- **R-AIACT-003** — Official German terminology corrected in ~14 definitions (e.g. "Fähigkeiten mit hoher Wirkkraft", "Marktüberwachungsbehörde"); missing qualifiers restored.
- **R-AIACT-005** — Art. 5(1)(h)(iii): offence threshold is a *maximum* sentence of at least four years, not a minimum sentence; authorisation alternative and Art. 99(3) "whichever is higher" restored.
- **R-AIACT-017** — bodyDe restored the *design*-control obligation (Entwurfskontrolle/-prüfung); previous text duplicated the development scope and lost it.
- **R-AIACT-019** — Log-retention: applicable Union law (esp. data protection) can also mandate *shorter* than 6 months; entry implied an absolute floor.
- **R-AIACT-027** — FRIA duty is not fine-sanctioned via Art. 99(4): Art. 27 is absent from the fine catalogue; unsupported 15M/3% bridge removed.
- **R-AIACT-046** — "Inverkehrbringen oder Inbetriebnahme" (not "Bereitstellung auf dem Markt"); "wichtiger" (not "kritischer") Industrie-/Infrastrukturanlagen.
- **R-AIACT-047** — Single EU declaration of conformity is *mandatory* when multiple Union acts require one; entry presented it as optional.
- **R-AIACT-079** — BaFin's Art. 74(6) examination scope limited to AI systems directly related to financial services; provisional-measure scope completed.
- **R-AIACT-086** — Right-to-explanation is not backed by Art. 99(4) fines via Art. 26; deployer (not the AI system) takes the decision.
- **R-AIACT-111** — Art. 111(2) binds *deployers* (Betreiber), not all operators; "in ihrer Konzeption erheblich verändert" restored.
- **R-AIACT-ANX-01** — Safety-component AI is high-risk only with the *second cumulative condition* (third-party conformity assessment); "automatically" removed.
- **R-AIACT-ANX-02** — Real-time RBI is also permitted for victim searches and imminent threats independent of the Annex II offence list; "prohibited outside these offences" corrected.
- **R-DORA-016** — Simplified framework (Art. 16): no access-control obligation exists; letter (c) duties (resilient systems, data availability/authenticity/integrity/confidentiality) restored.
- **R-DORA-024** — Annual testing covers systems supporting critical **or important** functions, not only critical ones.
- **R-DORA-031** — Exemption (iv) requires *both* single-Member-State conditions; entry dropped the second, overstating the exemption.
- **R-DORA-035** — Sub-outsourcing: recommendation to refrain, not a prohibition; 1%-daily penalty attaches only to measures (a)-(c) after ≥30 days, not to recommendations.
- **R-DORA-046** — Actor lists corrected: only critical-benchmark administrators; e-money institutions, AISPs, ART issuers, data reporting services, reinsurance intermediaries added.
- **R-DORA-047** — Coordinated supervision covers essential **and important** NIS2 entities; important entities were wrongly excluded in the body.
- **R-DORA-057** — Delegation revocation has *no* 3-month notice; the 3-month period belongs to objections against tacit renewal.
- **R-NIS2-002** — Scope exclusion covers only *public administration* entities in national-security roles; private defence/security companies are not excluded; CER/DNS size-independent applicability restored.
- **R-NIS2-021** — Art. 32(5) sanctions (certification suspension, management ban) apply to *essential* entities only; fine wording "Höchstbetrag von mindestens" corrected.
- **R-NIS2-026** — Main-establishment rule also covers domain registration services and managed security service providers; fallback criteria restored.
- **R-NIS2-028** — Registries must *answer* all access requests within 72h (grant only lawful, substantiated ones); entry misstated it as a duty to grant within 72h.
- **R-NIS2-031** — DORA cooperation sits in Art. 32(10)/33(6), not Art. 31; summary–body contradiction resolved.

### Known limitation

The verifying and adjudicating agents are AI systems; their verdicts cite exact source locations so any entry can be re-checked by a human in minutes. One systematic pattern for future extractions: bulk extraction tended to (a) drop actor-scope qualifiers ("other than microenterprises", "essential entities"), (b) simplify multi-condition rules to single conditions, and (c) soften or harden modal verbs ("may"/"shall"). These three checks should be part of any future extraction gate.
