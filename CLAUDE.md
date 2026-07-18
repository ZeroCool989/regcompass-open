@AGENTS.md

## Koordination (verbindlich)

- Session-Start: `docs/EPIC_SECTIONED_GENERATION.md` lesen — dort stehen
  die festgezurrten Entscheidungen und der aktuelle Stationsstand; bei
  Widerspruch zu älteren Nachrichten gilt das Epic-Dokument.
- Vor jedem Diff-Report gilt die Reihenfolge: erst `gate-runner` (muss
  PASS melden), dann `aegis-reviewer`. Beide Befunde im Diff-Report
  ausweisen.

## Review-Gates (verbindlich)

- Nach jeder Implementierung und VOR dem Zeigen eines Diffs: den Subagent
  `aegis-reviewer` auf den Diff ansetzen. Befund im Diff-Report ausweisen.
  Blockierende Verstöße vor dem Zeigen fixen und als "gefixt nach Review"
  kennzeichnen.
- Bei Änderungen an KB-Einträgen (`lib/kb/*.json`) zusätzlich den Subagent
  `kb-verifier` ausführen und den Befund im Diff-Report ausweisen.
