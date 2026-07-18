# Epic: Sectioned Generation

Beliebig große Prompts dürfen nie mehr scheitern, ohne dass der User etwas
von internen Limits merkt. Dieses Dokument ist die autoritative Quelle für
festgezurrte Entscheidungen und den Stationsstand — bei Widerspruch zu
älteren Nachrichten gilt dieses Dokument. Session-Start: dieses Dokument
lesen (CLAUDE.md, Abschnitt Koordination).

## Architektur

```
User-Prompt (beliebig formuliert, DE/EN, unstrukturiert)
      │
      ▼
Haiku-Triage (~300 ms, unsichtbar, EIN kombinierter Call)
      ├─ SINGLE_PASS → bestehende Pipeline, UNVERÄNDERT
      └─ SECTIONED   → Plan-Pass (Sonnet) → Sections sequenziell → Assembler
                        alles persistiert (AegisJob), pausier-/resumebar
```

**Eiserne Regel:** Die User-sichtbare Schnittstelle ist ausschließlich das
SSE-Event-Set. Kein internes Ereignis (Retry, Verify-Failure, Pause,
Modellwahl, Timeout) erreicht den User als Fehler oder Anforderung.

## Festgezurrte Entscheidungen

| # | Entscheidung |
|---|---|
| F1 | Message-Limit 32 000 Zeichen, env-überschreibbar (`AEGIS_MESSAGE_MAX_CHARS`); Server-Zod-Bound und Client-`maxLength` aus EINER Konstante (`lib/aegis/limits.ts`), immer im selben Commit ändern. |
| F2 | Resume als eigener SSE-Endpoint `GET /api/aegis/jobs/[id]/stream`. Ownership ausschließlich über den Join Job → `AegisConversation` (sessionId/userId); fremder Zugriff → 404 (kein Existenz-Orakel). Kein natives Last-Event-ID (Client nutzt fetch-Reader, kein EventSource) — jobId ist der Cursor. |
| F3 | Ein pausierter Job läuft nur weiter, wenn ein Client reconnected (neue Invocation). Tab zu = Job pausiert sauber. Hintergrund-Fortsetzung (Queue/Cron) ist bewusst out of scope. |
| F4 | Resume-Limiter: (1) Ownership-Check VOR jedem Budget-Verbrauch, (2) eigener Bucket per Session (nicht der 30/h-IP-Bucket), (3) Hard-Cap `AEGIS_JOB_MAX_RESUMES=12` — atomarer Increment (updateMany mit Guard), danach Job `failed` + Audit-Eintrag. |
| F5 | Zwei SSE-Contracts: SINGLE_PASS behält das bestehende Event-Set byte-identisch (status, tool_result, thinking_clear, token, replace_text, verify_retry, attachment, ping, done, error); das neue Section-Event-Set gilt nur für SECTIONED. Transportfehler (401/403/404/429) bleiben HTTP-JSON vor Stream-Beginn. Assemblierter Report wird zusätzlich als normale `AegisMessage` persistiert (History/Export). |
| F6 | Kein Playwright-Setup in PR 3 — Reducer-/Hydration-Tests in vitest, E2E manuell. Playwright ist ein separates Vorhaben. |
| F7 | EIN kombinierter Haiku-Triage-Call (mode + complexity + deliverableKind) ersetzt `classifyIntent` 1:1 für CONVERSATIONAL und läuft neu für strukturierte Modi. `voice: true` → immer SINGLE_PASS, Triage übersprungen. Fail-open: Haiku-Fehler → deterministische Heuristik entscheidet allein. |
| F8 | Section-Verify nutzt `verifyResponse` unverändert mit section-lokalem `allowedIds`-Scope. `grounded=false` → relaxtes Profil (skip citation_coverage / unsupported_regulatory_claim; language_consistency / non_empty bleiben). `KNOWN_EXTERNAL_STANDARDS`-Allowlist kommt erst in PR 2 und gilt nur für SECTIONED (SINGLE_PASS-Verify unverändert); Treffer werden als "unverified reference" markiert (Fußnote + Audit), kein Silent-Pass, kein Retry. |
| F9 | Grounded Sections brauchen Tools: pro Section begrenzter Tool-Loop (max. 4 Iterationen, Sonnet, `AEGIS_SECTION_MAX_TOKENS=4096`), Mechanik aus `runInnerLoopStreaming` wiederverwendet. Verify-Failure → max. `AEGIS_SECTION_REPAIR_MAX=2` tool-freie Repair-Pässe (`runToolFreeRepair`), dann Status `degraded`, Job läuft weiter. NIE Voll-Regeneration des Jobs. |
| F10 | `AegisJob` trägt `expiresAt` (Retention-Cron) und `resumeCount`; Statusübergänge als reines TS-Statechart (planning→running→paused↔running→done\|failed), ungültige Übergänge werfen. Digests folgen dem Muster aus `digest.ts` inkl. Citation-Firewall (`enforceCitations`). |
| P1 | Prozess: Investigate → (Findings nur bei Abweichung) → Implementieren → gate-runner → aegis-reviewer → Diff-Report inkl. beider Befunde → Bestätigung → Commit → DANACH `prisma db push`. |
| P2 | Datenbank: lokale `db push` und alle Executor-Läufe in der Entwicklung nur gegen den Neon-Dev-Branch; Prod-Schema-Sync ist ein expliziter Schritt nach Merge. |
| P3 | Zeitbudget: Vor jeder Section `timeLeftMs` prüfen; < `AEGIS_RESUME_TIME_FLOOR_MS` (90 000 — eine grounded Section inkl. Tool-Loop + Digest passt nicht zuverlässig in 60 s) → Job `paused`, sauber returnen, kein Fehler-Event. Halbfertige Sections werden nie persistiert. |

## Stationsstand

**Vorab-Fix — Done.** `no_hallucinated_regulations` bekommt einen
tool-freien Repair-Pass statt Voll-Regeneration (Timeout-Verstärker
entschärft). Gemerged als PR #11 (`c991770`, Feature-Commit `18218af`).

**Hotfix Time-Gating — Done** (Branch `fix/aegis-time-gating`): liefert
die ursprünglich als Epic-Voraussetzung definierten Timeout-Patches nach,
die neben dem Regulation-Repair nie implementiert worden waren (Beleg:
Dev-Log, POST /api/aegis 4,9 min — Continuation startete ungeprüft in die
290-s-Deadline). Inner-Loop-Time-Gating (Continuation-Skip unter
`AEGIS_CONTINUATION_TIME_FLOOR_MS=75000` + Note), Retry-Gate für ALLE
Failure-Typen (`RETRY_RESERVE_MS`), budget-aware `max_tokens`
(`budgetedMaxTokens`: Restzeit × 40 tok/s, Floor 2048, Cap Mode-Ceiling),
Client-Draft-Erhalt bei Timeout (Partial + zentraler Truncation-Hinweis in
`lib/aegis/statusLabels.ts` statt Wipe).

**fill_template von Conversation-Findings — Done** (Branch
`feat/aegis-template-source-abstraction`, eigenständig neben der
Sectioned-Pipeline): `FillSource`-Abstraktion (`document` byte-identisch |
`conversation` mit optionalen `messageIds`), mode-aware Extraktion für alle
vier Modi (`finding`/`gap`/`recommendation`-Discriminator; CONVERSATIONAL
mit Haiku-Klassifikations-Gate, konservativ), Citation-Firewall nach dem
Digest-Muster, deterministisches TS-Spalten-Mapping (Empfehlung ≠ Mangel:
`[EMPFEHLUNG]`-Prefix + `not_applicable`), vollständige `sourceRef`-Provenienz
im Fill-Ergebnis/Audit, unverifizierte Quellen (`verify_degraded`/Banner)
markiert (`manualReview` + Hinweis). ToolContext um `userId`/`conversationId`
erweitert (Ownership vor jeder Verarbeitung, kein Existenz-Orakel). Hinweis:
Timeout-Drafts aus #12 existieren nur client-seitig — die Marker-Erkennung
deckt sie dennoch ab, falls sie künftig persistiert werden.

**PR 1 / Station 1 — Done** (Commit `0846001` auf
`feat/aegis-sectioned-pipeline`): Triage-Modul
(`lib/aegis/sectioned/triage.ts`), Plan-Pass (`lib/aegis/sectioned/plan.ts`,
Zod: max 20 Sections, Token-Cap, disjunkte covers[], grounded ⇒ kbDomain),
Prisma-Schema `AegisJob`/`AegisJobSection`, F1-Limits. 27 neue Tests inkl.
Compliance-Fixture. Noch NICHT verdrahtet — Live-Verhalten unverändert.

**PR 1 / Station 2 — implementiert** (Branch `feat/aegis-sectioned-station-2`,
2026-07-17; Hinweis: Station-1-Referenz `0846001` ist der Pre-Rebase-Hash —
gemerged als `5f8bd6d`): Wiring (`lib/aegis/index.ts`, F7-Triage ersetzt
`classifyIntent` bei aktivem Flag; Voice → immer SINGLE_PASS), Statechart +
Job-Store (`statechart.ts`/`job-store.ts`, F10: reine TS-Statecharts, ungültige
Übergänge werfen; alle Writes status-guarded via `updateMany`), Executor
(`executor.ts`, F9/P3: sequenziell, ≤4 Tool-Iterationen/Sonnet/4096, Verify per
F8 inkl. relaxtem Profil für `grounded=false`, ≤2 tool-freie Repairs →
`degraded`, Zeit-Gate vor jeder Section, halbe Sections werden nie persistiert),
Section-Digest mit Citation-Firewall, Resume-Endpoint
(`app/api/aegis/jobs/[id]/stream/route.ts`, F2/F4: Ownership vor Budget,
eigener Session-Bucket, atomarer Resume-Cap → Job failed + Audit), stiller
SINGLE_PASS-Fallback bei `PlanValidationError` (Audit-Event). Assembler ist
bewusst naiv (`assemble.ts`, Single-Site-Swap in PR 2). **Flag-gated:**
`AEGIS_SECTIONED_ENABLED=0` default — Live-Verhalten byte-identisch
(regression-getestet in `index-sectioned-wiring.test.ts`); Flag-On erst nach
PR 3 (Client-UI). Kein Schema-Change, kein `db push` erfolgt (P2: nur
Neon-Dev-Branch — steht noch aus). 57 neue Tests, Gesamtsuite 1004 grün.

**PR 2 — implementiert** (Branch `feat/aegis-sectioned-pr2-pr3`, 2026-07-18):
Per-Section-Checks in `section-checks.ts` — Duplikate als WORT-Trigramme
(3-Wort-Shingles, Ratio gegen den AKTUELLEN Abschnitt, Schwelle
`AEGIS_DUP_TRIGRAM_THRESHOLD`), Scope-Check (coversNot als Überschrift oder ≥3
Nennungen), Widerspruchs-Heuristik (Modalverb-Clash auf geteilten
Vokabular-Termen, bewusst konservativ, NUR Audit — kein Repair-Verbrauch).
Blockierende Befunde (Duplikat/Scope) teilen sich das F9-Repair-Budget.
`KNOWN_EXTERNAL_STANDARDS` in `section-verify.ts`: Namensliste (kein
Pattern-Freibrief — "ISO 99999" fällt weiter durch), JEDER Treffer wird
footnotet (`EXTERNAL_STANDARDS_FOOTNOTE_DE`) + auditiert, unabhängig davon, ob
die Verify-Regex die Schreibweise erkennt; excust wird ausschließlich ein
`no_hallucinated_regulations`-Fail nach Neutralisierung. Deterministischer
Assembler (`assemble.ts`): Plan-Reihenfolge, Heading-Demotion,
Verbatim-Block-Dedupe (≥240 Zeichen), ehrliche Labels (Beratungsinhalt /
degraded per `DEGRADED_SECTION_NOTE_DE` — D9: nie aus Zeitdruck), optionaler
additiver Haiku-Glue-Pass hinter `AEGIS_GLUE_PASS_ENABLED` (default off,
fail-open).

**PR 3 — implementiert** (gleicher Branch): reiner Reducer
`applySectionedEvent` + Effekte (resume/finalize/fail) im Client-Store,
Section-Tokens spiegeln in die bestehende Streaming-Ansicht,
Auto-Reconnect bei `job_paused` (Budget clientseitig 15, Reset bei echtem
Fortschritt; Server-Cap F4 bleibt die harte Grenze), Resume-on-Reload via
localStorage (`maybeResumeStoredJob`), Stream-Ende bei aktivem Job = Pause,
nie Fehler (Eiserne Regel). Fertigstellungs-Meta ehrlich (F7/D9): alle
Sections verifiziert ⇒ grün; irgendein `degraded` ⇒ "Verifizierung
unvollständig". `components/aegis/ReportProgress.tsx` (Gliederung mit ruhigem
Per-Section-Status), deutsche Texte zentral in `statusLabels.ts`.
Reducer-/Hydration-Tests in vitest (F6). Gesamtsuite 1052 grün.

**E2E-Befund (2026-07-17/18, Dev-Server + Neon-Dev-Branch, Flag an, echter
Haiku/Sonnet):** Der Compliance-Fixture-Prompt erreichte in DREI Läufen nie die
Section-Ausführung — der Plan-Pass fiel jeweils durch die deterministische
Validierung und degradierte STILL zu SINGLE_PASS (User sah nie einen Fehler:
die Fallback-Mechanik ist damit dreifach live bewiesen). Ursachen in Folge:
(1) covers/kbDomains-Arrays über den Caps → GEFIXT (Clamping statt Rejection),
(2) Section-Titel >200 Zeichen → GEFIXT (alle kosmetischen Caps clampen jetzt),
(3) der echte Sonnet-Plan verletzt die GEPINNTE covers[]-Disjunktheit
(Keyword "externe Modelle" in zwei Sections) — **entschieden 2026-07-18
(Option a): deterministisches Ownership-Dedup.** `normalizePlanOwnership`
läuft VOR der refined Validierung: in Plan-Reihenfolge gehört jedes
normalisierte Keyword dem ERSTEN Abschnitt, der es beansprucht; spätere
Claims werden entfernt. Leert sich ein covers[] dadurch vollständig, wird der
Abschnitt gemerged (sein Titel wandert als Keyword in den vorherigen
Abschnitt, sofern unowned) bzw. entfernt — seine Themen sind andernorts
owned. Die gepinnte Regel bleibt autoritativ: der refined `AegisPlan`-Check
läuft unverändert danach und die Disjunktheit gilt nun per Konstruktion statt
per Hoffnung auf Modell-Compliance. Normalisierung wird auditiert
(`aegis_plan_ownership_normalized`).

**Station-2/PR-1–3-Regressionsziel ERREICHT — grüner E2E (2026-07-18, nach
Credit-Aufladung):** Compliance-Fixture gegen Dev-Server (Flag an, echte
Haiku/Sonnet-Calls, Neon-Dev-Branch), Test-Envs `AEGIS_STREAM_DEADLINE_MS=
120000`, `AEGIS_RESUME_TIME_FLOOR_MS=45000`, `AEGIS_SECTION_MAX_TOKENS=1400`.
Beleg (Job `cmrq7u1oq0001w4tqgkomrqvh`): Triage → SECTIONED, Plan-Pass ohne
Fallback (Ownership-Dedup griff), 9 Sections sequenziell, ALLE `done` mit
`firstPassOk=true` (Section-Verify jeweils im ersten Anlauf; Checks liefen,
Widerspruchs-Heuristik nur Audit), FÜNF saubere P3-Pausen mit Resume über
`GET /api/aegis/jobs/[id]/stream` (state-Replay + Fortsetzung ab Cursor,
9 Rows / 9 distinkte Indizes — keine Duplikate, resumeCount 5 ≤ Cap 12),
assemblierter Report als `AegisMessage` persistiert (`sectioned_done`,
54 466 Zeichen), Event-Strom ohne einen einzigen user-sichtbaren Fehler.
Wall-Clock 607 s über 6 Invocations à ≤120 s — beliebig lange Arbeit in
begrenzten Invocations, genau der Zweck des Epics. Flag-Flip in deployten
Umgebungen: Entscheidung des Koordinators (Rollout-Empfehlung: Dev/Preview
zuerst, Prod nach Beobachtung).

**Regressions-Ziel:** Der Compliance-Fixture-Prompt (9 Sections + Compliance-Katalog,
Fixture in `lib/aegis/sectioned/__tests__/fixtures.ts`) läuft nach PR 1–3
vollständig durch — ohne Timeout, ohne User-sichtbaren Fehler.

## Next / offene Punkte

- **Blocker Station 2:** Neon-Fakten ausstehend — ist
  `ep-gentle-field-ali0ywgk` Prod oder Dev? Falls Prod: Dev-Branch-Host
  für die lokale `.env`. Kein Executor-Lauf gegen die Job-Tabellen vorher.
- ~~**Chore nach PR 1:** `docs/source/CHECKSUMS.sha256`-Manifest anlegen +
  kb-verifier-Prüfung (1) scharfschalten~~ — **Done** auf Branch
  `feat/governance-hardening` (Manifest + `scripts/validate-kb.ts`-CI-Gate +
  kb-verifier-Checksummen-Pflicht; siehe `docs/governance/MIGRATION_NOTES.md`).
- **Nach PR 2:** Entscheidung, ob `KNOWN_EXTERNAL_STANDARDS` auch für
  SINGLE_PASS gelten soll (ursprünglicher ISO-27001-Verstärker; durch den
  Vorab-Fix bereits entschärft, aber Repair kostet einen Call).
- **Separat:** Playwright-Einführung (F6); Vercel-Plan verifizieren
  (`maxDuration=300` erfordert Pro/Fluid).
