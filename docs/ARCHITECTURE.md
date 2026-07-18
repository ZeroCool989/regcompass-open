# Architecture

RegCompass Open is a single-user, local-first application. Everything — the web UI, the AEGIS engine, the knowledge base, model credentials, and all stored data — runs on the user's own machine. There is no shared backend and no multi-tenant account system.

## Runtime shape

- **Web app:** Next.js (App Router), served locally (`next dev` / `next start`) on `localhost`.
- **Storage:** a single local **SQLite** database file, accessed through Prisma. Conversations, uploaded documents, generated jobs, and usage logs all live there.
- **Identity:** a single implicit local user. Because the app runs on the user's own machine and uses the user's own model credentials, there is no login, allowlist, or admin approval — those concepts only exist in a hosted, multi-tenant deployment.

Running locally with a long-lived process also removes the wall-clock limits of serverless functions, so large assessments are bounded only by the model, not by an execution deadline.

## AEGIS

AEGIS is a tool-using regulatory advisor. Its behavior is defined by a small set of hard rules (see `docs/CLAUDE.md`):

- Answers are grounded in the knowledge base; the model never invents requirements, scores, or citations.
- Severity and classification come only from curated knowledge-base fields and deterministic derivation — never from the model.
- Every factual claim cites a specific requirement id, and verification status is always surfaced.

The engine, its tools, the verification layer, and the export/deck generators are all pure logic that operate on data and credentials passed in — independent of any particular model vendor.

## The pluggable brain

AEGIS talks to models through a provider-adapter layer rather than a single vendor SDK. The design follows the common multi-provider router pattern:

- A **neutral representation** of messages, tool calls, tool results, stop reasons, and streaming events — the engine's internal domain model, independent of any vendor's wire format.
- A **wire-API registry**: a small set of adapters, each implementing one wire protocol. Because many vendors speak the same protocol, a single OpenAI-compatible adapter covers OpenAI, local runtimes (Ollama and similar), self-hosted gateways, and hosted routers. Anthropic and Google native protocols get their own adapters.
- A **model catalog** mapping selectable models to the adapter that serves them, plus their cost and capability metadata.

### Credential resolution

Each turn resolves a credential for the selected model from, in order: an explicit runtime override, a stored API key, a stored subscription OAuth token (refreshed if expired), or an environment variable. Credentials are stored locally with restrictive file permissions and never leave the machine.

Provider connection methods:

- **API key** — pasted or set via environment; used directly against the vendor endpoint.
- **Subscription OAuth** — the standard OAuth 2.0 authorization-code flow for native apps: a loopback redirect to `127.0.0.1` (RFC 8252) with PKCE (RFC 7636), following each provider's official developer documentation. The browser round-trips on the user's own machine and the resulting token is stored locally.
- **CLI bridge** — for a provider fronted by a local command-line tool, AEGIS invokes that tool as the model backend.

## Knowledge base

The knowledge base is a set of structured requirement, regulation, and crosswalk records plus the primary-source texts they cite. It loads from a configurable location, so the app can run against the bundled knowledge base or one the user supplies. Every requirement records how and when it was verified against its primary source, and that status travels with each answer.
