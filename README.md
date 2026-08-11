# RegCompass Open

A local-first regulatory-assessment assistant for AI in financial services. Runs entirely on your own machine and works with **any model as the brain** — your API keys, your model subscription, a local model, any OpenAI-compatible endpoint, or a CLI you already have installed.

At its core is **AEGIS**, a citation-grounded regulatory advisor that answers only from a retrieved knowledge base — never from the model's own memory — and clearly separates verified facts from interpretation. It maps and explains obligations under frameworks such as the EU AI Act, DORA, GDPR, NIS2, and FINMA expectations, and produces client-ready deliverables (Excel, PowerPoint, Word, PDF) with sources and verification status attached.

Because it runs locally, there is no shared server holding anyone's credentials: each person connects their own model and their own data stays on their own machine.

## Bring your own brain

AEGIS is model-agnostic. Point it at whichever backend you prefer:

- **API keys** — Anthropic (Claude), OpenAI, Google (Gemini).
- **Any OpenAI-compatible endpoint** — Ollama and other local runtimes, self-hosted gateways, or hosted routers (Together, Groq, OpenRouter, and similar). One endpoint URL is all it needs.
- **Model subscriptions** — sign in with your own Claude, ChatGPT/Codex, or Gemini subscription via the standard local OAuth loopback flow; the token stays on your machine.
- **CLI bridge** — drive AEGIS through a command-line tool you already use.

## Knowledge base

RegCompass Open ships with a curated regulatory knowledge base and can also point at your own. Every answer cites the specific requirement it draws from, and requirements carry an explicit verification status so you always know what has been checked against a primary source and what has not.

## Quickstart

**Requirements:** [Node.js](https://nodejs.org) 20 or newer. The installer handles everything else.

**One command** (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/ZeroCool989/regcompass-open/main/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/ZeroCool989/regcompass-open/main/install.ps1 | iex
```

The installer fetches the source, installs dependencies, creates a local database, and generates the app secrets. Then start it:

```bash
regcompass-open          # builds on first run, then opens http://localhost:3000
```

Prefer to do it by hand? Clone the repo, run `pnpm install`, `pnpm setup`, and `pnpm start`.

## No login required

By default there are no accounts and nothing to sign up for: the app runs as a single local user, and the only setup is connecting a model brain (next section). Your conversations, documents, and credentials belong to that implicit local identity.

**Sharing one instance with a team?** Set `AUTH_MODE="multi"` in `.env` to turn on the full account stack: people register at `/register` (fully offline, no email verification), the first account on a fresh database automatically becomes the approved administrator, and later accounts start as *pending* until an admin approves them under **Benutzerverwaltung** (`/admin/users`). Any data from previous no-login use is handed to that first admin account. Two optional switches: `AUTH_ALLOWLIST` restricts registration to listed email addresses, and `ADMIN_EMAILS` auto-admits listed addresses as admins.

## Getting started: choose your brain

Out of the box you can browse the knowledge base immediately. To run an assessment, open **http://localhost:3000 → Konto → AI-Provider** and connect a model:

- **API key** — paste a Claude, OpenAI, or Gemini key.
- **Model subscription** — sign in with your own Claude, ChatGPT/Codex, or Gemini subscription (a one-time OAuth-client setup is described in [docs/OAUTH_SETUP.md](docs/OAUTH_SETUP.md)).
- **Local model** — point it at a local Ollama (`http://localhost:11434/v1`) or any OpenAI-compatible runtime.
- **Self-hosted endpoint** — any OpenAI-compatible URL, including your own hosted model.
- **CLI you already use** — drive AEGIS through an installed `claude`, `codex`, or `gemini` CLI.

Every option can also be set in `.env` (see `.env.example` for `AEGIS_BRAIN` and the per-provider variables).

## Your data and your knowledge base stay local

Everything — conversations, uploaded documents, generated deliverables, and any credentials you add — is stored on your machine: a single SQLite database file plus, for subscription logins, a `~/.regcompass-open/auth.json` token file with owner-only permissions. Nothing is ever sent to a shared server, and there is no code path that pushes your data anywhere.

The knowledge base is yours to change. Point `KB_DIR` at your own folder of KB JSON files and edit them freely (see [docs/KNOWLEDGE_BASE.md](docs/KNOWLEDGE_BASE.md)); the app loads your copy at startup. Your edits never leave your machine and cannot be pushed back to this repository — make your own fork if you want to publish a KB.

## Regulatory news (no LLM needed)

The **Regulatorik News** page collects recent regulatory developments from official supervisor RSS feeds (EBA, ESMA, Deutsche Bundesbank, FINMA out of the box) — no model call involved. Refresh it any of three ways:

- **`pnpm news:refresh`** — run it manually, or put it in a cron job (e.g. `0 7 * * * cd /path/to/regcompass-open && pnpm news:refresh`).
- **"Jetzt aktualisieren"** button on the news page.
- **`POST /api/regulatory-news/refresh`** — for a scheduled trigger; protect it with `CRON_SECRET` if the instance is reachable by others.

Bring your own feeds with `REGULATORY_FEEDS_FILE`, or set `REGULATORY_NEWS_PROVIDER=llm` to use Claude + web search instead of RSS. See `.env.example`.

## Upgrades, backups & data safety

RegCompass migrates and **backs up** your local database automatically before the
app starts, and refuses to start rather than risk an unknown database state. It
binds to loopback (`127.0.0.1`) by default and refuses network exposure unless you
run authenticated multi-user mode. See
[docs/UPGRADES_AND_BACKUP.md](docs/UPGRADES_AND_BACKUP.md) for migration states,
backup location/permissions, the restore procedure, and how to recover if a
migration is intentionally refused. **Keep your `.env`** — your provider
credentials are encrypted with its `AEGIS_BYOK_ENCRYPTION_KEY`.

## Troubleshooting

- **`NODE_MODULE_VERSION` / native module error after changing Node versions:** the local database driver is a native module compiled for the Node version you installed with. If you switch Node versions, run `pnpm rebuild better-sqlite3` in the install directory.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Author

Almir Dumisic
