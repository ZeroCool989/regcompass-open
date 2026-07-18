# REVIEW_SAMPLE — aegis-reviewer Probelauf

Referenzlauf des `aegis-reviewer` gegen den bekannt-guten Commit
`18218af` (fix(aegis): tool-free repair pass for hallucinated regulation
names, gemerged als #11). Zweck: Kalibrierung des Invarianten-Wordings —
ein guter Commit muss CLEAN sein; flaggt der Reviewer ihn blockierend,
ist das Wording falsch, nicht der Commit.

Ausgeführt: 2026-07-06, Branch `chore/agents-review-gate`.

## Befund (wörtlich)

CLEAN

Prüf-Lücke (kein Verstoß): `lib/aegis/sectioned/plan.ts` existiert auf
diesem Branch nicht — Invariante 1 dort nicht prüfbar, vom Diff aber auch
nicht berührt.

Geprüft: `lib/aegis/verify.ts` (CHECK_ORDER/SOFT_CHECKS/
`no_hallucinated_regulations` unverändert, Check bleibt hard); neuer
Repair-Pfad in `lib/aegis/loop.ts` folgt exakt dem geblessten Muster aus
Invariante 2 (einmaliger tool-freier Repair, Re-Verify durch denselben
unveränderten `verifyResponse`, Annahme nur bei ok/soft, sonst
Fall-through auf Full-Retry; kein Degrade-Banner für diese Familie);
Accept-Entscheidung bleibt deterministisch (Invariante 1); LLM-Call nur
über bestehenden `callClaude`-Seam (Invariante 5); SSE-Event-Set und
Verify-Profile byte-identisch, nur bestehendes `replace_text` genutzt
(Invariante 4); keine Exit-Pfade/Usage-Logging berührt (Invariante 3);
Nudge-Texte sind Modell-Prompts, keine User-facing Strings (Invariante 6);
keine Secrets/env vars/DB-Änderungen (Invarianten 7/8).

## Bewertung

Erwartung erfüllt: CLEAN, eine erwartete Prüf-Lücke (Datei aus Station 1
liegt auf dem Feature-Branch, nicht auf main). Kein Wording-Fix nötig.
