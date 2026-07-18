# Verification Records

Machine-readable, per-entry verification records for the RegCompass knowledge base. Each file documents one verification campaign; together with the per-entry `verificationMethod`/`verified` metadata in `lib/kb/requirements.json` and the source checksums in `docs/source/CHECKSUMS.sha256`, they form the traceable verification chain (who / when / method / evidence) that can be demonstrated to clients.

## Files

- `2026-07-17-bulk-sweep.jsonl` — dual-pass verification of all 172 bulk-extracted entries (EU AI Act, DORA, NIS2) against the primary source texts in `docs/source/`.

## Record format (one JSON object per line)

| Field | Meaning |
|---|---|
| `id` | KB requirement ID (`lib/kb/requirements.json`) |
| `date` | Verification date |
| `method` | How the entry was verified. For the 2026-07-17 sweep: two independent AI agent passes, each locating the cited article in the German primary source and checking every claim (actors, deadlines, thresholds, scope, penalties); the second pass was explicitly adversarial. Severity disagreements between passes were re-verified by a third adjudicating agent. |
| `p1Verdict` / `p2Verdict` | Independent verdicts of pass 1 and pass 2 |
| `finalVerdict` | Merged verdict: `accurate`, `minor-deviation`, or `substantive-error` (higher-severity pass wins; adjudicator overrides) |
| `factType` | `restatement` (pure source content), `interpretation` (adds analysis, e.g. AI-relevance framing), or `mixed` |
| `issues` | What deviated from the source (empty for accurate entries) |
| `evidence` | Source location and quote supporting the verdict |
| `fixedFields` | KB fields corrected as a result (empty if none) |
| `sourceFile` | Primary source document in `docs/source/` the entry was verified against |

## Chain of trust

1. Primary sources: official German texts in `docs/source/`, pinned by SHA-256 in `docs/source/CHECKSUMS.sha256` (CI-enforced via `scripts/validate-kb.ts`).
2. Verification: recorded here per entry, per campaign; verdicts always cite the source location.
3. KB metadata: `verificationMethod` + `verified` on every entry in `lib/kb/requirements.json` reflect the latest campaign; `verified: false` means a known issue is pending a fix and the UI/AEGIS must disclose the status.
4. Corrections: applied fixes are reviewable in git history (commit-per-campaign) and mirrored in `docs/VERIFICATION_REPORT.md`.
