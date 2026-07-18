# AEGIS — Current Architecture

> **Status:** Current state as of 2026-07-15. This replaces the archived
> decision document
> [AEGIS_ARCHITECTURE_DECISION_2026-05-25.md](../archive/AEGIS_ARCHITECTURE_DECISION_2026-05-25.md),
> which described modules (`lib/scoring/`, `lib/ai/`) that were never built
> in that form. Every path below exists in the repository; the markdown
> link checker (`scripts/check-doc-links.ts`) keeps it that way.

AEGIS is a citation-grounded regulatory advisor. The knowledge base is the
only source of regulatory truth; a deterministic verifier enforces that
every regulatory claim in a response cites a KB requirement that a tool
actually returned during the same turn.

## Request flow

```
POST /api/aegis
  → intent/model routing         lib/aegis/router.ts
  → mode prompts                 lib/aegis/prompts/ (identity, mode_*)
  → tool loop (streaming)        lib/aegis/loop.ts
      tools:                     lib/aegis/tools/ (search_kb, get_requirements,
                                 get_crosswalk, read_source, read_source_passages,
                                 search_ingested_documents, fill_template,
                                 generate_assessment_deck, …)
  → deterministic verify         lib/aegis/verify.ts
      on failure: tool-free repair passes (citation-repair.ts), then
      degraded banner — never a silent pass
  → digest / compaction          lib/aegis/digest.ts (enforceCitations firewall)
```

A sectioned pipeline for arbitrarily large reports is being added behind
triage (`lib/aegis/sectioned/`) — authoritative plan and status:
[docs/EPIC_SECTIONED_GENERATION.md](../EPIC_SECTIONED_GENERATION.md).

## Grounding guarantees (code, not prompts)

- `verifyResponse` (lib/aegis/verify.ts): citation coverage per paragraph,
  cited IDs must be in the turn's `allowedIds` (returned by tools) and
  resolve via `KB.byId`; unknown regulation names fail; regulatory claims
  without citations fail.
- `enforceCitations` (lib/aegis/digest.ts): strips citation tokens from
  digests that are not present in the source transcript, so compaction can
  never launder hallucinated citations into accepted context.
- Conversation-findings extraction (lib/aegis/conversation-findings.ts)
  applies the same firewall for template filling.
- Severity of gap findings is derived deterministically from KB fields
  (`deriveSeverity` in lib/aegis/gap-finding.ts) — never model-assigned.
  Rubric: [docs/governance/SCORING_RUBRIC.md](../governance/SCORING_RUBRIC.md).

## Knowledge base

- Data: `lib/kb/requirements.json` (265 entries), `lib/kb/regulations.json`
  (19), `lib/kb/crosswalk.json` (15); Zod schemas in `lib/kb/types.ts`,
  parsed at import in `lib/kb/index.ts`.
- Provenance: every entry carries `sourceFile` resolving into
  `docs/source/` (SHA-256 manifest `docs/source/CHECKSUMS.sha256`) plus
  verification metadata (`verified`, `verifiedBy`, `verifiedAt`,
  `verificationMethod`).
- Integrity gate: `scripts/validate-kb.ts` (schema, references, duplicates,
  provenance, checksums, article-reference existence) — runs in CI.

## Operating rules

AI behaviour rules (citations mandatory, no legal advice, binding-level
disclosure, deterministic severity): [docs/CLAUDE.md](../CLAUDE.md).
