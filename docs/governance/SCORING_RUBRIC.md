# Scoring Rubric — KB Classification Governance

**Status:** Binding for every new or modified entry in `lib/kb/requirements.json`.
**Enforced by:** `scripts/validate-kb.ts` (enum validity), kb-verifier subagent (content), human review (judgment).

Every classification on a KB entry must be explainable from this rubric. The
language model never assigns or alters any of these values at runtime — it
only reads them (see `docs/CLAUDE.md`, AI Operating Rules).

## 1. The three classification axes

RegCompass deliberately separates three axes that are often conflated:

| Axis | Field | Question it answers |
|------|-------|--------------------|
| Regulatory risk tier | `riskTier` | Which risk class does the *regulation itself* assign to the AI system? (EU AI Act taxonomy) |
| Financial-sector relevance | `relevanceForFinancialSector` | How much does this requirement matter to a bank / asset manager / insurer? |
| Binding level | `bindingLevel` | How legally binding is the source? |

The user-facing severity (Critical/High/Medium/Low on gap findings) is
**derived deterministically** from relevance × binding level — see §5.
See ADR-001 for why `riskTier` is not a severity scale.

## 2. `riskTier` — canonical values (ADR-001)

Only these values are valid (Zod-enforced):

| Value | Meaning (EU AI Act anchor) |
|-------|---------------------------|
| `prohibited` | Practices banned outright (Art. 5 AI Act) |
| `high-risk` | High-risk AI systems (Art. 6 + Annex III) |
| `limited-risk` | Transparency-obligation systems (Art. 50) |
| `minimal-risk` | All remaining AI systems |
| `gpai` | General-purpose AI model obligations |
| `gpai-systemic` | GPAI with systemic risk |
| `all` | Requirement applies regardless of risk class (also used for non-AI-Act regulations) |

Synonyms (`high`, `unacceptable`, `limited`, `minimal`) are **rejected** by the
schema. Legacy data is canonicalized by `scripts/kb-migrate-governance.ts`.

## 3. `relevanceForFinancialSector` — objective criteria

Assign the highest tier whose criteria are met:

### `critical`
At least one of:
- Non-compliance can trigger **licence-threatening supervisory measures** or
  direct business restrictions for a financial institution (e.g. BaFin/FINMA
  order, withdrawal of authorisation).
- Fines in the top bracket of the regulation (e.g. AI Act Art. 99(3)
  prohibited practices; GDPR Art. 83(5); DORA competent-authority measures for
  core ICT risk-management failures).
- The requirement is a **precondition for operating** the regulated activity
  (e.g. DORA ICT risk-management framework, MaRisk AT 4 risk management).
- Failure directly endangers client assets, market integrity, or reportable
  operational continuity (incident-reporting duties with hard deadlines).

### `high`
- Mandatory obligation with material fines or enforceable supervisory
  expectations, but not licence-threatening in the ordinary case; or
- prerequisite for other critical obligations (documentation, registration,
  conformity assessment); or
- supervisory expectation the German/Swiss supervisor examines in routine
  inspections (MaRisk/BAIT/FINMA circular core Tz./Rz.).

### `medium`
- Obligations with limited enforcement exposure for financial institutions in
  the deployer role, or with long transition periods; or
- obligations that primarily bind other actors in the value chain (importers,
  distributors) but still create indirect duties for banks.

### `low`
- Definitional, scoping, transitional, or programmatic provisions;
  innovation-support and cooperation clauses; provisions relevant mainly to
  authorities.

### Consistency invariant
A `best_practice` source can never be `critical` (there is no enforcement to
make it so). This cross-check is part of manual review; the current data set
satisfies it.

## 4. `bindingLevel` — determination rules

| Source type | `bindingLevel` |
|-------------|----------------|
| EU Regulation (AI Act, DORA, GDPR, Data Act, DSA), directly applicable | `mandatory` |
| EU Directive as transposed (NIS2 → national law), national statute (BDSG, BSIG, revDSG) | `mandatory` |
| RTS / ITS (delegated or implementing acts under DORA etc.) | `mandatory` |
| Supervisory circulars and guidance the supervisor examines against (MaRisk, BAIT, FINMA-Rundschreiben, FINMA-Aufsichtsmitteilungen, EBA Guidelines under "comply or explain") | `supervisory_expectation` |
| Voluntary standards and frameworks (ISO 42001/42005/23894, NIST AI RMF) | `best_practice` |

Notes:
- MaRisk/BAIT are formally "Verwaltungsvorschriften"; they are classified
  `supervisory_expectation`, and their statutory anchor (§ 25a/§ 25b KWG) is
  what makes deviations enforceable — name the anchor in
  `enforcementConsequence`.
- A harmonised standard cited under the AI Act presumption-of-conformity
  mechanism stays `best_practice`; the presumption belongs in the entry body.

## 5. Derived severity (runtime, deterministic)

`lib/aegis/gap-finding.ts` → `deriveSeverity()`:

| relevance \ binding | mandatory | supervisory_expectation | best_practice |
|---------------------|-----------|------------------------|---------------|
| critical | Critical | Critical | — (invariant §3) |
| high | High | High | High |
| medium | High | Medium | Medium |
| low | Low | Low | Low |

This table is code. Changing it requires updating `deriveSeverity()` and this
rubric in the same commit.

## 6. Scoring metadata

Every entry whose classification is assigned or changed after 2026-07-15
must carry:

```ts
scoredBy: string       // person or documented process, e.g. "manual-scoring-2026-07"
scoredAt: string       // ISO date
scoreRationale: string // one to three sentences referencing §3/§4 criteria
```

Entries scored before this rubric existed may lack these fields; they are
backfilled opportunistically whenever an entry is touched. The kb-verifier
flags classification changes without updated scoring metadata.

## 7. Review cadence

- Any KB diff that changes `relevanceForFinancialSector`, `bindingLevel`, or
  `riskTier` requires kb-verifier plus human sign-off in the PR.
- Quarterly: sample 10 entries per top regulation and re-justify their
  scores against §3/§4 (documented in `docs/governance/` as a dated note).
