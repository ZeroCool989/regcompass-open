# Knowledge Base

AEGIS answers strictly from a curated knowledge base (KB): a set of regulatory
requirements, their controls, cross-mappings, and the primary source texts they
were extracted from. A verified KB ships with this repository and is used by
default. You can also point the app at your own KB.

## Using a custom knowledge base

Set `KB_DIR` to a directory containing your KB:

```bash
KB_DIR=/absolute/path/to/my-kb pnpm dev
```

When `KB_DIR` is set, the app, the `read_source` tool, and the KB scripts all
read from it instead of the bundled KB. When it is unset, the bundled KB is used.

## Directory layout

```
<KB_DIR>/
  requirements.json     # the requirements (the bulk of the KB)
  regulations.json      # regulation metadata (id, shortName, …)
  crosswalk.json        # cross-regulation mappings
  manifest.json         # audit snapshot (regenerate with `pnpm kb:manifest`)
  source/
    *.txt               # primary legislation / standard texts
    CHECKSUMS.sha256    # optional: sha256 of each source file
```

`requirements.json`, `regulations.json`, and `crosswalk.json` are validated
against the Zod schemas in `lib/kb/types.ts`. Key points:

- `regulation` and `category` are free strings, so a custom KB may define its
  own regulations and category slugs. `BUNDLED_REGULATIONS` and
  `BUNDLED_CATEGORIES` in `lib/kb/types.ts` document the canonical values that
  ship with this repo.
- Each requirement's `sourceFile` must be a plain filename present in
  `<KB_DIR>/source/`. The `read_source` tool derives its regulation → file map
  from these `sourceFile` fields, so no code changes are needed for a new KB.
- The tool input schemas (`search_kb`, `read_source`) list the regulations from
  the **loaded** KB, so the model only ever sees regulations that exist.

## Regenerating and validating

```bash
KB_DIR=/path/to/my-kb pnpm kb:manifest    # regenerate manifest.json
KB_DIR=/path/to/my-kb pnpm validate:kb    # schema, references, checksums
```

`validate:kb` checks schema conformance, that every `sourceFile` resolves under
`source/`, checksum agreement with `CHECKSUMS.sha256` (when present), and that
`manifest.json` is not stale.

## Verification note

The bundled KB is the verified default: its entries were cross-checked against
their primary sources, and each carries provenance metadata (`verified`,
`verificationMethod`, `verifiedAt`). A custom KB is **your** responsibility to
verify — the app enforces schema and source-file resolution, not the factual
accuracy of your entries. Unverified entries surfaced through `read_source` are
always flagged as not KB-verified in AEGIS's answers.
