# Threadline

Inspired by me forgetting all the characters and events in the Wandering Inn
after taking a break from reading.

Threadline is a two-part prototype:

1. An **offline extraction pipeline** (Node + TypeScript) that turns an EPUB
   into a "thread" — a structured JSON file describing a book's characters,
   relationships, and plot events. Threads are precomputed offline by parsing
   an EPUB into chapter text, sending chapters to the Claude API for
   extraction, and merging the per-chapter results.
2. A **static wiki web app** (`web/` — Vite + React, no server) that imports a
   thread JSON and turns it into a browsable, spoiler-gated mini-wiki. The
   centerpiece is a **chapter cap** — "show me the world as of chapter N" — so
   you can catch up to exactly where you stopped reading without spoilers.

Each pipeline stage writes inspectable JSON to `/output` before the next stage
consumes it, so a bad parse can be caught before any API budget is spent on it.

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

This is the part that costs money — the extraction stages make real Claude API
calls (roughly **$0.20–$2 per book** depending on model choice). Stage 3 shows
a cost estimate and asks for confirmation before spending anything.

### 1. Set up your API key

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

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

### 3. Or run each stage manually

The one-shot command above just chains these three stages. Run them by hand if
you need finer control (e.g. re-extracting a single chapter):

```
# Parse EPUB → clean chapter text (output/{slug}-parsed.json)
npm run parse -- input/your-book.epub

# Inspect the index ↔ chapter mapping (no API call)
npm run extract -- output/your-book-parsed.json --list

# Extract the whole book, checkpointed to output/{slug}-chunks/
npm run extract-book -- output/your-book-parsed.json --dry-run   # preview cost first
npm run extract-book -- output/your-book-parsed.json

# Merge chunks into the final thread (output/{slug}-thread.json)
npm run merge-thread -- output/your-book-parsed.json
```

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
| `npm run extract -- output/book-parsed.json <index\|--list>` | Extract/inspect a single chapter |
| `npm run extract-book -- output/book-parsed.json [flags]` | Full-book extraction (`--dry-run` previews cost) |
| `npm run merge-thread -- output/book-parsed.json [flags]` | Merge chunks into the thread |
| `npm run web` | Run the web app dev server |
| `npm test` | Run the pipeline test suite (no API calls) |
| `npm run test:web` | Run the web test suite |
| `npm run build` | Compile the pipeline TypeScript to `dist/` |

Useful `extract-book` flags: `--from N` / `--to N` / `--skip 3,5`
`--force [12,13]` / `--yes` / `--rebuild-manifest`. Useful `merge-thread` /
`book` flags: `--out <path>` / `--progression-order <path>`.

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
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)
