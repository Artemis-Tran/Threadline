# Threadline

Inspired by me forgetting all the characters and events in the Wandering Inn
after taking a break from reading. Also me exploring the capabilities of agentic
development.

Threadline is a two-part prototype:

1. An **offline extraction pipeline** (Node + TypeScript) that turns an EPUB
   into a "thread" — a structured JSON file describing a book's characters,
   relationships, and plot events. Threads are precomputed offline by parsing
   an EPUB into chapter text, sending chapters to an LLM API (OpenAI or
   Anthropic, your choice per run) for extraction, and merging the per-chapter
   results.
2. A **static wiki web app** (`web/` — Vite + React, no server) that imports a
   thread JSON and turns it into a browsable, spoiler-gated mini-wiki. The
   centerpiece is a **chapter cap** — "show me the world as of chapter N" — so
   you can catch up to exactly where you stopped reading without spoilers.

The pipeline is three steps — parse, extract, merge. Each writes inspectable
JSON to `/output` before the next consumes it, so a bad parse can be caught
before any API budget is spent on it.

---

## Quick start (web app only)

If you just want to see the app, you don't need an API key or any EPUB — the
web app ships with **The Potter's Path** seeded as a default example on first
run.

```
npm install
npm run web
```

Then open the printed local URL (Vite defaults to http://localhost:5173). The
library will already contain the example book — click it to explore.

> The web app is a workspace under `web/`. `npm install` from the repo root
> installs both the pipeline and the web dependencies.

---

## Generating a thread from your own EPUB

This is the part that costs money — the extract step makes real API calls
(roughly **$0.25 per book** on the default model, and up to **$4–7** on the
priciest). It shows a cost estimate and asks for confirmation before spending
anything.

### 1. Set up your API key

Extraction defaults to `gpt-5.6-luna`, an OpenAI model, so **a run with no
`--model` flag needs an OpenAI key**. Create a `.env` file in the project root:

```
OPENAI_API_KEY=sk-...
```

Running an Anthropic model instead (`--model sonnet`, `haiku`, `opus`) needs
`ANTHROPIC_API_KEY` and not the OpenAI one — only the key for the vendor you
are actually calling. If it is missing, the run stops before spending anything
and names the variable it wanted.

`.env` is gitignored and must never be committed.

### 2. One-shot pipeline (recommended)

Drop an EPUB in `input/` and run the whole parse → extract → merge chain with a
single command:

```
npm run book -- input/your-book.epub
```

Preview the plan and cost without spending anything first:

```
npm run book -- input/your-book.epub --dry-run
```

The result is written to `output/{slug}-thread.json`. Import that file into the
web app (see below).

### 3. Or run each step manually

The one-shot command above just chains these three steps. Run them by hand if
you need finer control:

```
# Parse EPUB → clean chapter text (output/{slug}-parsed.json)
npm run parse -- input/your-book.epub

# Inspect the index ↔ chapter mapping (no API call, costs nothing)
npm run extract-book -- output/your-book-parsed.json --list

# Extract the whole book, checkpointed to output/{slug}-chunks/
npm run extract-book -- output/your-book-parsed.json --dry-run   # preview cost first
npm run extract-book -- output/your-book-parsed.json

# Merge chunks into the final thread (output/{slug}-thread.json)
npm run merge-thread -- output/your-book-parsed.json
```

### Probing a single chapter

Before paying for a whole book, extract one chapter and read the result:

```
npm run extract -- output/your-book-parsed.json --list   # find the chapter index
npm run extract -- output/your-book-parsed.json 8
```

This is a thin wrapper around `extract-book`: it translates the index into a
one-chapter extraction window and forwards everything else, so the probe sends
the same request a book run sends and goes through the same cost confirmation.
Output lands in `output/{slug}-probe-{model}/`, keyed by model so probing a
second one never overwrites the first, and readable by `compare-extractions`.
A repeat probe on the same chapter re-extracts — the confirmation prompt is
what stops you paying twice by accident.

**Trying another model.** Extraction defaults to `gpt-5.6-luna`, but any
command that hits the API takes `--model <id>` (a full id, or the shorthands
`luna` / `terra` / `sonnet` / `haiku` / `opus`); each model is priced correctly
in the cost estimate. Luna is the default on price — roughly 15× cheaper than
Sonnet — rather than on a measured quality win, and the quality comparison
between them is genuinely open (ADR-0009). What a cheap model tends to get wrong
here is the roster — promoting unnamed walk-ons to characters, or splitting one
person across several entries — so if a thread comes out noisy that is the thing
to look at, and switching costs one flag. A/B before committing to one: extract a
candidate into a separate directory (so it doesn't overwrite your baseline) and
diff the two:

```
npm run extract-book -- output/your-book-parsed.json --model sonnet --out-dir output/your-book-chunks-sonnet
npm run compare-extractions -- output/your-book-chunks output/your-book-chunks-sonnet --label-a luna --label-b sonnet
```

The comparison reports per-chapter counts, roster differences, and each run's
real cost.

### 4. Load the thread into the web app

```
npm run web
```

In the library, use **Import** (or drag-and-drop the JSON onto the page) to add
`output/{slug}-thread.json`. Your library and reading position persist in the
browser (IndexedDB); use **Export** to back up or move it.

---

## What to expect (web app preview)

**Library page** — a list of imported books. Ships with The Potter's Path
seeded on first run. Import threads by drag-and-drop or file picker, delete
individual books, or export/import the whole library as a single JSON backup.
Everything is stored locally in the browser — there is no account or server.

**Book page** — opens on a chosen book with:

- **Chapter cap** — a slider that sets "the world as of chapter N." Every view
  below is recomputed from the thread's historical records filtered to that
  cap, so you never see a fact from past where you've read.
- **Characters tab** — a searchable roster as of the cap. Click a character to
  drill into their details and relationships, with cross-links to other
  characters.
- **Timeline tab** — plot events up to the cap, in order.

The chapter cap, active tab, and selected character are synced to the URL (so
deep links work) and remembered per-book across visits.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run book -- input/book.epub [--dry-run]` | One-shot parse → extract → merge |
| `npm run parse -- input/book.epub` | Parse an EPUB to chapter JSON |
| `npm run extract-book -- output/book-parsed.json [flags]` | Full-book extraction (`--dry-run` previews cost, `--list` shows chapter indices) |
| `npm run extract -- output/book-parsed.json <index\|--list>` | Probe a single chapter (wraps `extract-book`) |
| `npm run merge-thread -- output/book-parsed.json [flags]` | Merge chunks into the thread |
| `npm run compare-extractions -- <dirA> <dirB>` | A/B two chunk dirs (counts, roster, cost) |
| `npm run web` | Run the web app dev server |
| `npm test` | Run the pipeline test suite (no API calls) |
| `npm run test:web` | Run the web test suite |
| `npm run build` | Compile the pipeline TypeScript to `dist/` |

Useful `extract-book` flags: `--list` / `--from N` / `--to N` / `--skip 3,5`
`--force [12,13]` / `--yes` / `--rebuild-manifest` / `--model <id>` /
`--out-dir <path>` / `--roster <path>`. Useful `merge-thread` / `book` flags:
`--out <path>` / `--progression-order <path>`. `book` also accepts
`--model <id>`.

---

## Deployment

The web app is a static site deployed to **GitHub Pages** via
`.github/workflows/deploy.yml`, which builds `web/` and publishes it on every
push to `master`. Live site: https://artemis-tran.github.io/Threadline/

The Pages base path is `/Threadline/` (set in `web/vite.config.ts`, overridable
via the `THREADLINE_BASE` env var). Enabling Pages with Source = "GitHub
Actions" in the repo settings is a one-time manual step outside the repo.

---

## Project structure

- `/src` — extraction pipeline source (pure CLI; no web/DB deps)
- `/web` — the static wiki SPA (Vite + React + IndexedDB; npm workspace)
- `/tests` — pipeline `node:test` suite (`web/tests` for the web suite)
- `/input` — sample EPUB files (gitignored)
- `/output` — generated JSON (gitignored)
- `.env` — `OPENAI_API_KEY` (the default model's vendor) and/or
  `ANTHROPIC_API_KEY` (gitignored, never committed)
