# Threadline

A prototype tool that takes an EPUB file and generates a "thread" — a
structured JSON file describing a book's characters, relationships, and
plot events. Threads are precomputed offline by parsing an EPUB into
chapter text, sending chapters to the Claude API for extraction, and
merging the per-chapter results.

Each pipeline stage writes inspectable JSON to `/output` before the next
stage consumes it, so a bad parse can be caught before any API budget is
spent on it.

## Pipeline stages

1. **Parse** (`src/parse-epub.ts`) — EPUB → clean chapter text
   (`output/{slug}-parsed.json`)
2. **Single-chapter probe** (`src/extract-chapter.ts`) — one extraction
   API call against one chapter, for inspecting raw model output
3. **Full-book extraction** (`src/extract-book.ts`) — per-chapter
   extraction with a running character roster, checkpointed to
   `output/{slug}-chunks/` with a `manifest.json`
4. **Merge** (`src/merge-thread.ts`) — dedupe/merge the chunks into
   `output/{slug}-thread.json`
5. **Reader UI** — not started

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Create a `.env` file in the project root containing your API key:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```

## Scripts

Stages 2 and 3 make real API calls that cost money; stage 3 shows a cost
estimate and asks for confirmation before calling.

- `npm run parse -- input/book.epub` — parse an EPUB to chapter JSON
- `npm run extract -- output/book-parsed.json <chapter-index|--list>` —
  extract a single chapter (`--list` shows the index↔chapter mapping
  without an API call)
- `npm run extract-book -- output/book-parsed.json [--dry-run] [--from N]
  [--to N] [--skip 3,5] [--force [12,13]] [--yes] [--rebuild-manifest]` —
  extract the whole book (`--dry-run` previews the plan and cost)
- `npm run merge-thread -- output/book-parsed.json [--dry-run] [--out
  <path>] [--progression-order <path>]` — merge chunks into the thread
- `npm test` — run the test suite (no API calls)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — env smoke check (prints whether `ANTHROPIC_API_KEY`
  loaded)

## Project structure

- `/src` — source code
- `/tests` — `node:test` suite
- `/input` — sample EPUB files (gitignored)
- `/output` — generated JSON (gitignored)
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)
