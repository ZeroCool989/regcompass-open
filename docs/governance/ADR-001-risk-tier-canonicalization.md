# ADR-001: riskTier canonicalization — keep regulatory tiers, don't fold them into severity

**Date:** 2026-07-15
**Status:** Accepted

## Context

The `riskTier` field on KB requirements allowed near-duplicate enum values
(`high` vs `high-risk`, `prohibited` vs `unacceptable`, `limited` vs
`limited-risk`, `minimal`), and the live data used them inconsistently.

The hardening mandate proposed normalizing `riskTier` to
`critical | high | medium | low | best-practice`.

## Decision

We canonicalize `riskTier` **within its own semantic space** instead of
adopting the proposed severity-style enum:

```
prohibited | high-risk | limited-risk | minimal-risk | all | gpai | gpai-systemic
```

Synonym mapping (applied by `scripts/kb-migrate-governance.ts`, rejected by
the Zod schema afterwards):

| Legacy | Canonical |
|--------|-----------|
| `unacceptable` | `prohibited` |
| `high` | `high-risk` |
| `limited` | `limited-risk` |
| `minimal` | `minimal-risk` |

## Rationale

`riskTier` is the **EU AI Act's own classification** of the AI system a
requirement applies to (Art. 5 prohibited practices, Art. 6/Annex III
high-risk, Art. 50 transparency, GPAI chapters). It answers "which systems
does this requirement bind?" — a legal-scope fact taken from the source text.

`critical/high/medium/low` is RegCompass's **relevance judgment** for
financial-sector clients; it already exists as
`relevanceForFinancialSector`, and `best-practice` is already a
`bindingLevel`. Folding the AI Act taxonomy into that scale would:

1. destroy legal meaning (a `prohibited`-tier requirement is not "critical
   severity" — it is a scope statement: the practice is banned);
2. duplicate `relevanceForFinancialSector` under a second name;
3. make the citation-faithfulness goal worse, because the KB would no longer
   mirror the source taxonomy the AI must cite.

## Consequences

- Zod schema (`lib/kb/types.ts`) rejects all synonym values; CI
  (`scripts/validate-kb.ts`) fails on any regression.
- Display labels (`lib/kb/labels.ts`) carry exactly the canonical set.
- Severity shown to users remains **derived** from
  `relevanceForFinancialSector` × `bindingLevel`
  (`deriveSeverity()`, documented in `docs/governance/SCORING_RUBRIC.md` §5).
