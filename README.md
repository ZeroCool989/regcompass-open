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

> A one-command installer is on the way. For now, run it from source:

```bash
git clone https://github.com/ZeroCool989/regcompass-open.git
cd regcompass-open
pnpm install
cp .env.example .env        # add a model key, or configure a provider in the app
pnpm prisma db push         # creates the local database
pnpm dev                    # open http://localhost:3000
```

All data — conversations, uploaded documents, generated deliverables — is stored locally in a single SQLite database file.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Author

Almir Dumisic
