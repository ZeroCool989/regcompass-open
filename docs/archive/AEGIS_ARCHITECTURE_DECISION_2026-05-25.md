# AEGIS — Architecture Decision Document

> **ARCHIVED 2026-07-15.** Historical decision document. It references
> modules that were never built in this form (`lib/scoring/`, `lib/ai/`,
> `lib/reporting/`) — links inside this document are not maintained. The
> current architecture is described in
> [docs/aegis/ARCHITECTURE.md](../aegis/ARCHITECTURE.md).

> **Status:** Draft v1 · **Datum:** 2026-05-25 · **Eigner:** RegCompass Core Team
> **Vorgängerdokumente:** [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/CLAUDE.md](../CLAUDE.md)

## TL;DR — Entscheidungen auf einen Blick

| Entscheidung | Wahl | Warum |
|---|---|---|
| Pattern | Tejas Kumar Harness (5 Komponenten) | Klare Trennung Tool/Context/Guardrails/Loop/Verify; testbar |
| Modul-Layout | `lib/aegis/` neben `lib/ai/`, `lib/kb/`, `lib/scoring/` | Greenfield-Modul; kein Eingriff in bestehende Pfade |
| KB-Zugriff Phase 1 | Direkter JSON-Import (`KB.search`, `KB.byId`) | 265 Einträge passen in Memory; pgvector verzögert MVP |
| Model Routing | Haiku/Sonnet/Opus je Mode | ~77 % Kostenersparnis ggü. All-Opus bei 1k req/d |
| Verify | 5 deterministische Checks, **kein Model-Call** | Halluzinations-Stop ohne weitere Kosten |
| Erste API-Surface | `POST /api/aegis` | Chat-UI ist Phase 5; Demo-fähig API-only |
| Auth Phase 1 | Keine | Wie bestehende Routen; persistenter Rate-Limit + Auth ist Phase 2 |
| Tool-Surface | 5 KB-zentrische Tools, kein Internet/FS | Hard Boundary gegen Drift |

---

## 1. Kontext & Problemstellung

### RegCompass heute (KB v2026-05-25)
- **265 verifizierte Anforderungen** aus 19 Regulationen (EU/CH/DE/INTL), **160 Controls**, **15 Crosswalk-Einträge** — alle source-verified gegen Primärtexte in [docs/source/](../source/).
- **Deterministische Scoring-Engine** ([lib/scoring/](../../lib/scoring/)): 26 Regeln, 15 Golden Cases, 32 Tests. Gleicher Input → identisches Ergebnis.
- **Claude-Explain als Side-Channel** ([lib/ai/explain.ts](../../lib/ai/explain.ts)): einmaliger Messages-Call pro Assessment, Citation-Validator, Fallback-Text bei API-Fehler. **Keine Tools, kein Streaming, kein Caching, keine mehrstufige Interaktion.**

### Was fehlt für „IT-Compliance Risk Advisor"
- Kein interaktiver Agent — Nutzer können keine Folgefragen stellen.
- Keine Policy-/Dokumenten-Analyse — Client-Policies können nicht hochgeladen und gegen die KB gespiegelt werden.
- Keine Kontroll-Empfehlungen jenseits der statischen `controls`-Listen.
- Kein Voice-Channel.
- Keine wiederverwendbare Konversations-Memory.

### Ziel: AEGIS
**A**I **E**ngine for **G**overnance, **I**nsight, and **S**urveillance — ein AI Agent Harness, der die KB als einzige Wahrheitsquelle nutzt und als IT-Compliance Risk Advisor agiert.

### Kernproblem
**LLMs halluzinieren.** In der Regulatorik ist das inakzeptabel — eine erfundene Article-Referenz oder ein erdichtetes Fine-Limit untergräbt Vertrauen sofort. Der Harness muss **strukturell garantieren**, dass jede Aussage auf der KB basiert:
- Tools sind die **einzige** Quelle externer Information (keine freie Generierung von Regulationsdetails).
- Verify-Schritt blockiert Antworten ohne valide Citation auf KB-IDs.
- Verbotene Phrasen werden post-hoc entfernt (kein „Rechtsberatung").
- System Prompt schärft "explain, never decide" wie schon in [docs/CLAUDE.md](../CLAUDE.md) festgelegt.

---

## 2. IST-Architektur (was existiert)

| Layer | Stand | Datei |
|---|---|---|
| Framework | Next.js 16.2.4 (App Router, Turbopack) | [next.config.ts](../../next.config.ts) |
| Runtime | React 19.2.4 + TypeScript 5 strict | [tsconfig.json](../../tsconfig.json) |
| Persistenz | Prisma 7.8 + Neon Postgres; Model `Assessment` (KBView entfernt 2026-05-25) | [prisma/schema.prisma](../../prisma/schema.prisma) |
| Claude SDK | `@anthropic-ai/sdk@^0.91.0` — nur `messages.create`, kein Tool-Use, kein Caching, kein Streaming | [lib/ai/explain.ts](../../lib/ai/explain.ts) |
| KB | 265 reqs / 160 controls / 19 regs / 15 crosswalks, Zod-validiert, statisch geladen | [lib/kb/index.ts](../../lib/kb/index.ts) |
| Scoring | 26 deterministische Regeln, 15 Golden Cases | [lib/scoring/](../../lib/scoring/) |
| UI | Tailwind v4 (CSS-Variables, kein Config-File), 8 Custom Components, R3F-Kompass | [app/globals.css](../../app/globals.css) |
| API | `/api/assess`, `/api/explain`, `/api/assessment/[id]/pdf`, `/api/health` | [app/api/](../../app/api/) |
| Auth | **Nicht vorhanden** — alle Routen public | — |
| Rate-Limit | In-Memory `Map` → wirkungslos auf Vercel Serverless (pro Lambda-Instanz) | [lib/rate-limit.ts](../../lib/rate-limit.ts) |
| Deploy | Vercel, Region `fra1` | [vercel.json](../../vercel.json) |

---

## 3. AEGIS Harness-Architektur (Tejas Kumar Pattern)

Fünf voneinander getrennte, einzeln testbare Komponenten:

```
┌─────────────────────────────────────────────────────────────┐
│ POST /api/aegis  { mode, message, conversationId? }         │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ AEGIS Harness                                               │
│                                                             │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │ Context Manager  │───▶│ Outer Loop (max 3 attempts)   │  │
│  │ (cache + compress)│    │  ┌──────────────────────────┐ │  │
│  └──────────────────┘    │  │ Inner Loop (max 10 iters)│ │  │
│           │              │  │  ┌──────────┐ ┌────────┐  │ │  │
│           ▼              │  │  │ Claude   │◀│ Pre    │  │ │  │
│  ┌──────────────────┐    │  │  │ Messages │ │ Guard  │  │ │  │
│  │ Tool Registry    │───▶│  │  └────┬─────┘ └────────┘  │ │  │
│  │ (5 KB tools)     │    │  │       │                   │ │  │
│  └──────────────────┘    │  │       ▼                   │ │  │
│                          │  │  ┌──────────┐ ┌────────┐  │ │  │
│                          │  │  │ Tool     │ │ Post   │  │ │  │
│                          │  │  │ Execute  │ │ Guard  │  │ │  │
│                          │  │  └──────────┘ └────────┘  │ │  │
│                          │  └──────────────────────────┘ │  │
│                          │           │                   │  │
│                          │           ▼                   │  │
│                          │     ┌──────────┐              │  │
│                          │     │ Verify   │── fail ──┐   │  │
│                          │     │ (5 checks)│         │   │  │
│                          │     └──────────┘          │   │  │
│                          └─────────┬─────────────────┘   │  │
│                                    ▼                     │  │
│                            { text, citations, cost }     │  │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Tool Registry
**Hard boundary:** der Agent kann **nur** diese Tools aufrufen. Kein Internet-Zugang, kein Filesystem-Zugang.

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `search_kb` | `query: string, filter?: {regulation?, jurisdiction?, audience?, category?, bindingLevel?}` | `Requirement[]` (top-N) | [`KB.search`, `KB.byRegulation`, …](../../lib/kb/index.ts) |
| `get_crosswalk` | `topic?: string \| requirementId?: string` | `CrosswalkEntry[]` | `KB.crosswalk` |
| `assess_risk` | `AssessmentInput` (gleiches Schema wie `/api/assess`) | `ScoringResult` | [`score()`](../../lib/scoring/engine.ts) — **wiederverwendet bestehende Engine** |
| `generate_report` | `assessmentId \| structured payload` | `{ format: 'pdf'|'docx', url }` | Phase 4 — Reuse [lib/reporting/](../../lib/reporting/) für PDF |
| `analyze_document` | `text: string, focus?: 'gap'|'control'` | `{ findings: [{ excerpt, regulation, requirementIds }] }` | Phase 4 — chunked retrieve + map auf KB |

Tool-Schemas folgen Anthropic Tool-Use Format. Keine Tool darf andere Tools triggern — der Agent orchestriert.

### 3.2 Context Management
- **System Prompt** = AEGIS Identity + Operating Mode + KB-Kontext-Pointer.
- **Prompt Caching:** System Prompt + Tool-Definitionen werden mit `cache_control: { type: 'ephemeral' }` markiert → erwarteter Cache-Hit ~90 % nach Warm-up.
- **Konversations-History:**
  - <20 Messages → 1:1 mitschicken.
  - ≥20 Messages → **Compression**: Haiku 4.5 fasst Messages [3 … N-4] in 200-Token-Summary; behalten werden System + initiale 2 User-Messages + letzte 4 Messages + Summary.
- **Persistenz:** Phase 1 stateless (`conversationId` optional, Client liefert History). Phase 2 → Prisma `Conversation` + `Message` Models.

### 3.3 Guardrails

**PRE (vor Claude-Call):**
| Guard | Limit | Aktion |
|---|---|---|
| Iteration count | >10 (Voice: >5) | `kill` mit `iteration_limit` |
| Cost accumulated | >$5 pro Conversation | `kill` mit `cost_limit` |
| Context size | >20 Messages | `compress` (siehe 3.2) |
| Banned input patterns | Prompt-Injection-Marker (`ignore previous`, `system:`) | `sanitize` + log |

**POST (nach Claude-Response):**
| Guard | Pattern | Aktion |
|---|---|---|
| Banned phrases | „Rechtsberatung", „legal advice", „I recommend you should" | `strip` (entferne Sätze, log Warning) |
| Citation requirement | Regex `\b(Art\.|§|Rz\.)\s*\d` ohne `[R-XXX-NNN]` im selben Absatz | `warn` (Verify entscheidet) |
| Empty response | <10 chars (excl. whitespace) | `fail` → Outer Loop retry |

**Voice-spezifisch:** zusätzlich `max_tokens: 1024`, max 5 Iterationen.

### 3.4 Agent Loop
```
outer_loop(max_attempts=3):
  reset_iter()
  while iter < 10:
    pre_guards.check()                       # may kill
    response = claude.messages.create({…tools, cache_control…})
    if response.stop_reason == 'tool_use':
       result = tool_registry.execute(response.tool_calls)
       append(result); iter++; continue
    if response.stop_reason == 'end_turn':
       text = post_guards.apply(response.text)
       v = verify(text, conversation, mode)
       if v.ok: return text, citations, cost
       else:    # outer retry with v.feedback appended as system note
                break  # → outer attempt++
    break
  raise AegisError(...)
```

### 3.5 Verify — 5 deterministische Checks (kein Model-Call)
| Check | Logik | Failure-Aktion |
|---|---|---|
| `citation_coverage` | Jedes `\b(Art\.|§|Rz\.)\s*\d` muss von einem `[R-XXX-NNN]` aus `allowedIds` (= Union der per Tool gelieferten KB-IDs) gefolgt sein | retry mit Feedback |
| `no_hallucinated_regulations` | Regulationsname (z. B. „DORA", „FINMA 08/2024") muss in `KB.regulations[].shortName` enthalten sein | retry |
| `language_consistency` | Response-Sprache (langdetect heuristisch über Top-200-Tokens) == `request.language` | retry |
| `non_empty_response` | `text.trim().length >= 10` | retry |
| `no_false_ignorance` | Wenn `tools_called > 0` und Tool-Results enthielten KB-Treffer, darf Response nicht „Dies wird von der aktuellen Wissensbasis nicht abgedeckt" enthalten | retry |

Erweiterung des bestehenden Validators in [lib/ai/validate.ts](../../lib/ai/validate.ts) — Logik wird teilweise wiederverwendet, aber AEGIS hat eigene Verify-Pipeline mit Feedback-Loop.

---

## 4. Model Routing Strategie

### Modelle und Preise

| Model | Model ID | $/MTok In | $/MTok Out | Sweet Spot |
|---|---|---:|---:|---|
| Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 | $5 | Intent-Klassifizierung, Compression, einfache Q&A |
| Sonnet 4.6 | `claude-sonnet-4-6` | $3 | $15 | ASSESS, GAP_ANALYZE, Reports, Voice, Standard Q&A |
| Opus 4.7 | `claude-opus-4-7` | siehe ⚠️ | siehe ⚠️ | CONTROL_ADVISE, komplexe Cross-Regulation-Analyse |

> ⚠️ **Pricing-Annahme zu verifizieren:** Die Brief-Vorgabe nannte „Opus 4.6 | $5 | $25". Aktueller Opus-Listenpreis (Stand 2026-05) liegt deutlich höher (~$15/$75 für Opus 4.x je MTok). Die nachfolgende Kostenrechnung verwendet die Brief-Werte; vor Produktionsstart muss die Anthropic-Pricing-Page geprüft und ggf. die Schwellen in `router.ts` angepasst werden.

> ⚠️ **Modellwahl:** Die Brief-Vorgabe nannte „Opus 4.6". Da Opus 4.7 inzwischen verfügbar ist (und Default für neue Apps gemäss Anthropic-Empfehlung), verwendet AEGIS **Opus 4.7**. Die Routing-Logik ist modellneutral — Wechsel auf 4.6 ist eine Konstanten-Änderung.

### Kostenrechnung bei 1000 Anfragen/Tag (Annahme: ~3k Input + ~1k Output je Request, mit Caching ~30 % Input-Reduktion nach Warm-up)

| Strategie | Tagesproduktion | $/Tag |
|---|---|---:|
| All-Opus | 1000 × (3M·$5 + 1M·$25) / 1M | **~$40 ggü. Brief / ~$125 bei realem Opus-Preis** |
| All-Sonnet | 1000 × (3M·$3 + 1M·$15) / 1M | ~$24 + Overhead → ~$60 |
| Smart Routing (60 % Sonnet, 30 % Haiku, 10 % Opus) | gewichtetes Mittel | **~$28** |

→ **77 % Einsparung** zu All-Opus, **53 %** zu All-Sonnet. Drei Hebel:

1. **Model Routing** (60–80 % Einsparung): Mode + Komplexitäts-Heuristik bestimmt Modell.
2. **Prompt Caching** (90 % auf System Prompt + Tools): `cache_control: { type: 'ephemeral' }` auf statischen Teilen.
3. **Batch API** (50 % auf Reports): Bulk-Report-Generation (z. B. nächtliche Kunden-Updates) läuft via `/v1/messages/batches`.

---

## 5. Operating Modes

| Mode | Input | Output | Default Model | Tools (typ.) |
|---|---|---|---|---|
| `ASSESS` | AI-System-Beschreibung (use case + attributes) | Risikoniveau + anwendbare Regulationen + Citations | Sonnet 4.6 | `assess_risk`, `search_kb` |
| `GAP_ANALYZE` | Client-Policy-Dokument (text/markdown) | Gap-Matrix: `compliant`/`partial`/`non-compliant` je Requirement | Sonnet 4.6 | `analyze_document`, `search_kb`, `get_crosswalk` |
| `CONTROL_ADVISE` | identifizierte Gaps (aus `GAP_ANALYZE` oder manuell) | Kontrollempfehlungen + Implementierungsschritte | **Opus 4.7** | `search_kb`, `get_crosswalk` |
| `CONVERSATIONAL` | freie Frage | KB-basierte Antwort mit Citations | **Haiku** wenn `intent==factual`, sonst Sonnet | `search_kb`, `get_crosswalk` |

**Mode-Eskalation:** `CONVERSATIONAL` kann während eines Turns zu `ASSESS` oder `CONTROL_ADVISE` eskalieren, wenn der Agent ein `assess_risk`-Tool aufruft oder eine Gap erkennt. Eskalations-Regeln sind in `router.ts` zentral.

---

## 6. KB-Integration Entscheidung

### Phase 1 (jetzt): Direct JSON Search
- Direkter Import aus [lib/kb/index.ts](../../lib/kb/index.ts) — gleiches `KB`-Objekt wie Scoring-Engine und `/api/explain`.
- Suche: `query.toLowerCase()` + `includes` über `title`, `summary`, `id`, `tags`, `controls[].action` (bereits implementiert in `KB.search`).
- Reranking heuristisch: exakter ID-Match > Title-Match > Summary-Match > Control-Match.
- **Kein pgvector. Keine Embeddings. Keine separate DB-Schicht.**

**Begründung:**
- 265 Einträge × ~2 KB ≈ 530 KB → passt komfortabel in Memory; KB ist bereits beim Page Load geladen.
- Textsuche reicht für MVP — Tool-Calls liefern dem Agent Kandidaten, das Modell macht das Semantic Matching im Reasoning.
- DB-Dependency (Vector-Indexing, Re-Indexing bei KB-Updates) verzögert Demo um Tage und lockt uns in eine konkrete Vector-DB-Wahl, die wir noch nicht treffen müssen.

### Phase 2 (später): pgvector + Usage Logs
- pgvector-Extension in Neon aktivieren.
- Embeddings (Voyage AI oder `text-embedding-3-small`) für jedes Requirement + Control.
- Hybrid-Search: BM25 + Cosine in Tool `search_kb`.
- Usage-Logs (`AegisRun` Tabelle): jeder Conversation-Turn mit Tokens, Cost, Tool-Calls, Verify-Status.

**Trigger für Phase 2:** wenn Top-10-Recall der Text-Suche unter 80 % fällt (gemessen via Eval-Set in `__tests__/`).

---

## 7. Integration in bestehendes Projekt

### Code-Layout
```
lib/aegis/                ← NEU, eigenes Modul
lib/ai/                   ← unverändert, bleibt für /api/explain
lib/kb/                   ← unverändert, AEGIS importiert KB
lib/scoring/              ← unverändert, AEGIS' assess_risk-Tool wraps score()
app/api/aegis/route.ts    ← NEU
app/aegis/page.tsx        ← OPTIONAL Phase 5 (Chat UI)
```

### Konkrete Touchpoints
- **Eigener Anthropic-Client** mit Tool-Use + Caching: `lib/aegis/client.ts` — **erweitert NICHT** [lib/ai/explain.ts](../../lib/ai/explain.ts).
- **KB**: `import { KB } from '@/lib/kb'` direkt — identisches Versions-Stamping (`KB.version`).
- **Scoring**: `import { score } from '@/lib/scoring'` für `assess_risk`-Tool — keine Duplikation.
- **Prisma**: Phase 2 erweitert `schema.prisma` um `Conversation`, `Message`, `AegisRun`. Phase 1 ist stateless.
- **Rate-Limit**: Phase 1 nutzt bestehendes [lib/rate-limit.ts](../../lib/rate-limit.ts) (In-Memory-Limit gilt — siehe Risk in §11). Phase 2 ersetzt durch Upstash/Postgres-basiert.
- **Sanitize**: bestehendes [lib/sanitize.ts](../../lib/sanitize.ts) wird in Pre-Guard wiederverwendet.

### Keine Eingriffe in
- Bestehende Seiten (`app/{assess,kb,history,…}/page.tsx`) — AEGIS hat eigene Routen.
- Bestehende API-Routen — AEGIS hat eigenen Endpunkt.
- KB-JSON-Dateien — read-only-Zugriff.
- Scoring-Engine — nur als Tool gewrappt, nicht modifiziert.

---

## 8. Abgrenzung: Was AEGIS *nicht* ist

| AEGIS ist nicht | Stattdessen |
|---|---|
| ein Ersatz für die deterministische Scoring-Engine | Engine bleibt einzige Wahrheit für reproduzierbare Risk-Tier-Klassifikation. AEGIS *nutzt* sie via Tool. |
| ein Ersatz für `/api/explain` | Explain-Endpoint bleibt für 1-Shot-Erklärungen pro Assessment. AEGIS ist der interaktive Kanal. |
| ein offener Chatbot | Themen-Scope ist hart auf Regulatorik beschränkt — System Prompt verweigert off-topic, Tools liefern nur KB-Inhalte. |
| ein Rechtsberater | „Explain, never decide" — siehe [docs/CLAUDE.md](../CLAUDE.md). Post-Guard streicht Beratungs-Sprache. |
| ein KB-Editor | KB wird über Source-Verification-Prozess gepflegt (siehe [docs/VERIFICATION_REPORT.md](../VERIFICATION_REPORT.md)). AEGIS ist read-only. |

---

## 9. Phasing

| Phase | Scope | Dependencies | Zeitschätzung |
|---|---|---|---|
| **1 — Harness Core** | Router · Guardrails · 5 Tools · Verify · `POST /api/aegis` · Tests | `@anthropic-ai/sdk` (vorhanden) | 2–3 Tage |
| **2 — Persistenz & Auth** | Prisma `Conversation`/`Message`/`AegisRun` · NextAuth (Provider TBD — siehe §11) · Postgres-/Upstash-Rate-Limit · pgvector für KB | Prisma-Schema-Erweiterung, Auth-Provider | 2–3 Tage |
| **3 — Voice** | Whisper STT + TTS (OpenAI oder ElevenLabs) · `<VoiceButton>` · Voice-spezifische Guardrails (5 iter, 1024 tokens) | OpenAI/ElevenLabs API-Key | 1–2 Tage |
| **4 — Reports & Document Analyzer** | `generate_report` mit `@react-pdf/renderer` oder `docx` · `analyze_document` mit Chunking | `@react-pdf/renderer` oder `docx` | 1–2 Tage |
| **5 — UI** | Chat-Interface `app/aegis/page.tsx` · Usage Dashboard (`recharts`) · Admin-View | `recharts` | 1–2 Tage |

**Hard Dependencies zwischen Phasen:** Phase 2 ist Voraussetzung für Phase 5 (kein User → kein User-spezifisches Dashboard). Phasen 3 und 4 sind unabhängig parallelisierbar nach Phase 1.

---

## 10. File Structure

```
lib/aegis/
├── index.ts                  # Public API: runAegis(), AegisRequest, AegisResponse
├── types.ts                  # Message, ToolCall, ToolResult, VerifyResult, Mode
├── client.ts                 # Anthropic wrapper (cache_control, messages.create)
├── router.ts                 # Mode + Komplexitäts-Heuristik → Modell-Wahl
├── modes.ts                  # ASSESS / GAP_ANALYZE / CONTROL_ADVISE / CONVERSATIONAL
├── loop.ts                   # Outer + Inner Agent Loop
├── verify.ts                 # 5 deterministische Checks
├── prompts/
│   ├── identity.ts           # AEGIS System Prompt (cached)
│   ├── mode_assess.ts
│   ├── mode_gap.ts
│   ├── mode_control.ts
│   └── mode_conversational.ts
├── tools/
│   ├── index.ts              # Tool-Registry + Anthropic-Schema-Export
│   ├── search_kb.ts          # wraps KB.search / byRegulation / byJurisdiction
│   ├── get_crosswalk.ts      # wraps KB.crosswalk
│   ├── assess_risk.ts        # wraps lib/scoring/engine.score()
│   ├── generate_report.ts    # Phase 4
│   └── analyze_document.ts   # Phase 4
├── guardrails/
│   ├── index.ts              # apply() entry point
│   ├── pre.ts                # iteration/cost/context/sanitize
│   └── post.ts               # banned-phrases/citation-warn/empty
├── context/
│   ├── compress.ts           # Haiku-basierte History-Compression
│   └── cost.ts               # Token → USD pro Modell, accumulator
└── __tests__/
    ├── router.test.ts        # Mode → Modell
    ├── verify.test.ts        # alle 5 Checks
    ├── guardrails.test.ts    # pre + post
    ├── loop.test.ts          # Inner-/Outer-Loop mit Mock-Client
    ├── tools.test.ts         # jedes Tool gegen reale KB
    └── golden_conversations.json   # Eval-Set für Verify-Recall

app/api/aegis/
└── route.ts                  # POST: { mode, message, conversationId?, language? }

app/aegis/                    # Phase 5 — optional
├── page.tsx                  # Chat UI
└── ChatPanel.tsx             # Client Component
```

**Konvention:** Jede Datei in `lib/aegis/` hat einen klaren Single-Responsibility-Anker. Tests spiegeln Quellpfade 1:1. Keine zirkulären Imports zwischen `tools/` und `loop.ts` — Tools werden injiziert.

---

## 11. Offene Fragen / Risiken

| # | Thema | Stand | Entscheidung nötig bis |
|---|---|---|---|
| R1 | **Opus-Pricing**: Brief nannte $5/$25 für „Opus 4.6"; reales Opus ist deutlich teurer. Kostenrechnung in §4 muss vor Produktionsstart neu kalibriert werden. | offen | vor Phase 1 Merge |
| R2 | **Auth-Provider Phase 2**: NextAuth mit welchem Provider? GitHub OAuth für Demo, Magic-Link via Resend für Pilot? | offen | vor Phase 2 |
| R3 | **In-Memory Rate-Limit auf Vercel**: bekannt wirkungslos. Phase 1 lebt damit; Phase 2 muss zwingend wechseln (Upstash Redis oder Neon-basiert). | bekannt | vor Phase 2 |
| R4 | **`language_consistency` ohne Library**: heuristische Detektion über Top-200-Tokens ist fragil bei Code/IDs. Eval-Set in `__tests__/` muss früh aufgebaut werden. | offen | Phase 1 |
| R5 | **API-Key-Rotation**: `.env.local` enthält Anthropic-Key im Klartext (siehe §11 der vorherigen Architektur-Analyse). Vor Demo rotieren. | offen | vor Demo |
| R6 | **Voice-Provider**: OpenAI Whisper vs. AssemblyAI vs. ElevenLabs (für TTS Cartesia/ElevenLabs). DSGVO/Standort relevant — Vercel-Region ist `fra1`. | offen | Phase 3 |
| R7 | **Cost-Accounting Telemetry**: Bei Phase 1 stateless — wie loggen wir Kosten ohne DB? Strukturiertes Logging in Vercel-Logs (best effort) reicht für MVP. | bekannt | Phase 1 |
| R8 | **i18n**: AEGIS soll DE/EN können; Rest der App ist DE-hardcoded. AEGIS-Layer entscheidet pro Request, UI-Layer braucht eigene Lösung. | bekannt | Phase 5 |

---

## 12. Erfolgsmetriken (Definition of Done je Phase)

| Phase | Metrik | Schwelle |
|---|---|---|
| 1 | Verify-Pass-Rate auf Golden Conversations | ≥ 95 % |
| 1 | Cost pro Conversation (avg) | < $0.10 |
| 1 | p95 Latency `/api/aegis` (1 Tool-Call) | < 6 s |
| 2 | Auth + Conversations persistiert | 0 verlorene Threads bei Reload |
| 3 | Voice-Roundtrip (STT + LLM + TTS) p95 | < 4 s |
| 4 | Report-Generation Erfolgsrate | ≥ 99 % |
| 5 | Chat-UI Time-to-First-Token | < 1.5 s |

---

## 13. Referenzen
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — Gesamtarchitektur RegCompass
- [docs/CLAUDE.md](../CLAUDE.md) — AI Operating Rules („explain, never decide")
- [docs/VERIFICATION_REPORT.md](../VERIFICATION_REPORT.md) — KB-Verifikationsstatus
- [lib/kb/types.ts](../../lib/kb/types.ts) — Zod-Schemas der KB
- [lib/scoring/engine.ts](../../lib/scoring/engine.ts) — deterministische Scoring-Engine
- [lib/ai/explain.ts](../../lib/ai/explain.ts) — bestehende Explain-Pipeline (zum Abgleich)
- [lib/ai/validate.ts](../../lib/ai/validate.ts) — bestehender Citation-Validator (Teilwiederverwendung in Verify)
