# Migration Notes — Governance Hardening (2026-07-15)

Applied by `scripts/kb-migrate-governance.ts` (idempotent; safe to re-run).
Validated by `scripts/validate-kb.ts` (CI gate).

## 1. Verification-metadata backfill

Source of truth: `docs/VERIFICATION_REPORT.md` (2026-05-25). The manual
verification sweep documented there had never been written back to the KB —
all 265 entries carried `verified: false`.

Backfilled per regulation:

- **90 entries → `verified: true`**, `verifiedBy:
  "manual-source-verification-2026-05-25"`, `verifiedAt: "2026-05-25"`,
  `verificationMethod: "manual-source-verification"` — all regulations from
  the report's manual sweep (GDPR, revDSG, FINMA 08/2024, FINMA RS 2023/1,
  FINMA RS 2018/3, DSA, MaRisk, BAIT, Data Act, BDSG, BSIG, Product
  Liability, NIST AI RMF, ISO 42001, ISO 42005).
- **EU AI Act (68), DORA (61), NIS2 (45)** stay `verified: false` with
  `verificationMethod: "primary-source-extraction"` (bulk extraction
  2026-05-19; paragraph-level manual review still outstanding — see
  report, Outstanding Work #2).
- **ISO 23894 (1)** stays `verified: false` with
  `verificationMethod: "automated-crosscheck-v1"`.

**Count discrepancy, resolved conservatively:** the report's summary says
"91 manually source-verified entries", but its own per-regulation table sums
to 90 manual + 1 automated (ISO 23894, explicitly "Pending manual QC pass").
We backfilled 90. The ISO 23894 entry is *not* marked verified.

Existing verification metadata is never overwritten by the migration.

## 2. `sourcePdf` → `sourceFile`

The legacy `sourcePdf` values (e.g. `germany/BDSG.pdf`,
`switzerland/FINMA_08_2024_EN.pdf`) did not resolve to files in this
repository and were dropped. Every entry now carries `sourceFile`: a plain
filename that must exist in `docs/source/` and be covered by
`docs/source/CHECKSUMS.sha256`.

**Waiver:** ISO_23894 has no primary source text in `docs/source/`; its
single entry (`R-ISO23894-AIRM`) carries no `sourceFile`. The waiver is
encoded in `PROVENANCE_WAIVERS` in `scripts/validate-kb.ts` and expires as
soon as a source text is added — then the waiver must be removed.

Code consumers updated: `lib/aegis/deck/deck-model.ts`,
`lib/aegis/deck/pptx-writer.ts`, `app/kb/[id]/page.tsx`.

## 3. riskTier canonicalization

2 entries migrated (`unacceptable` → `prohibited`, `high` → `high-risk`).
See ADR-001 for the canonical enum and why it is not a severity scale.

## 4. Control-ID collision repair

16 control occurrences processed, 14 IDs actually changed (for 2
occurrences the requirement-derived ID was identical to the original).
`C-FINMARS1-2023-01/02` and
`C-REVDSG-006-01/02` were each reused across multiple requirements with
**divergent content** — the same ID pointed to two or three different
controls. Every occurrence was renamed to a requirement-derived ID
(`C-<requirement-suffix>-NN`). Identical-content reuse
(`C-FINMARS3-2018-01/02`, shared across the FINMA RS 2018/3 entries) is
intentional and was left unchanged; the validator enforces "same control ID
⇒ identical content" from now on.

Control IDs are not referenced by any code path; the rename is data-only.

## 5. New provenance artifacts

- `docs/source/CHECKSUMS.sha256` — SHA-256 manifest over all 20 source
  texts. Any source-text change must regenerate the manifest in the same
  commit (`cd docs/source && shasum -a 256 *.txt > CHECKSUMS.sha256`);
  otherwise `validate-kb` and the kb-verifier fail.
- Schema additions (`lib/kb/types.ts`): `verificationMethod`,
  `verificationVersion`, `scoredBy`, `scoredAt`, `scoreRationale`,
  `sourceFile` (all optional in the schema; provenance requiredness is
  enforced by `scripts/validate-kb.ts`).
