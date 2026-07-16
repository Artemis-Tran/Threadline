# Project: Threadline

## What this is
A prototype tool that takes an EPUB file and generates a "thread" — a
structured JSON file describing a book's characters, relationships, and
plot events. The thread is built by parsing the EPUB into chapter text,
then sending chunks to the Claude API to extract structured entities.

The gist is to precompute these "threads" offline and match them to books a
user uploads, rather than running extraction live on arbitrary uploads.
The offline extraction pipeline (stages 1–4) is complete; stage 5 is a
dedicated local web app (`web/`) that stores thread + parsed JSONs in
SQLite and displays them.

## Current stage
The extraction pipeline (stages 1–4) is done. Stage 5 (web reader) is in
progress, split into 5a/5b — see `plans/stage5-web-reader-plan.md` for
the approved plan. Each stage is built and validated independently before
moving to the next one. Check with the user before jumping ahead, even if
the next step seems obvious.

Pipeline stages, in order:
1. ✅ EPUB parsing → clean chapter text (`src/parse-epub.ts`)
2. ✅ Single-chapter test extraction (one API call, inspect raw output) (`src/extract-chapter.ts`, verified on chapter 8)
3. ✅ Full chunking + per-chunk extraction with running context
   (`src/extract-book.ts`; verified on The Potter's Path — 47 chunks in
   `output/{slug}-chunks/`. Character names in that first run were
   repaired by a mechanical cleanup pass, marked `meta.postProcessed`
   in each chunk; the roster-contamination bug that caused it is fixed
   in the script, so future books won't need it.
   A freeform, per-book "system" data extraction field was scoped in
   `plans/system-data-schema-plan.md` but deferred — untouched for now.)
4. ✅ Entity merge/dedupe pass across chunks
   (`src/merge-thread.ts`; verified on The Potter's Path — writes
   `output/{slug}-thread.json` from the 47 chunks in
   `output/{slug}-chunks/`. Fixes `updateRoster`'s longest-string-wins
   description bug with a recency-first merge, and adds progression-order
   regression detection across chapters. Known limitation, confirmed
   against this book: the original motivating example — chapter 50
   (`idx050-extract.json`) indirectly revealing Davos Merrick is Green
   tier ("She was Green tier just like him") — is *not* fixable by this
   or any JSON-only merge. All 4 of his chunk appearances already agree
   on "Yellow tier" in the extracted description; the correct fact was
   never captured into structured JSON in the first place, so there's no
   cross-chunk contradiction to detect. That's a stage-3
   extraction-accuracy gap, not a merge bug — closing it would need an
   LLM-assisted pass that re-reads raw chapter text, deferred as future
   work since it costs real API money. The regression detector does work
   for genuine cross-chunk disagreements, confirmed via a real false
   positive it caught on this book: Lady Celeste's chapter 48 description
   misattributes Elise's "Orange tier potential" to Celeste herself,
   correctly flagged as a conflict — a known limitation of regex-only
   detection with no subject attribution, not something to chase with ad
   hoc regex tweaks.
   The hardcoded `TIER_ORDER`/tier-only detection has been generalized
   into a configurable-per-key progression-order engine — Tier is now
   that engine's built-in default entry (`DEFAULT_PROGRESSION_ORDERS`),
   not a separate special case; a book's own vocabulary (Level, Class
   Rank, etc.) can be plugged in via `--progression-order <path>`. No
   auto-inference from book text — a new key is only ever detected once a
   human explicitly configures it. `extractTier`/`detectTierConflicts`/
   `conflicts` keep their exact original names, signatures, and shapes for
   backward compatibility; every other configured key's regressions land
   in the new, separate `progressionRegressions` field instead. Verified:
   all 123 tests pass (`npm test`), `tsc` is clean, and a dry-run against
   the real `output/potters-path-1st-chunks/` fixture with no config
   produces byte-identical `conflicts`/`conflictCount` to before this
   change. See `plans/generalize-tier-detection-plan.md`. A freeform
   stage-3 "progression" extraction field remains a separate, deferred
   idea — see `plans/system-data-schema-plan.md`.)
5. Web reader app (`web/` npm workspace: Next.js App Router + SQLite via
   better-sqlite3; plan in `plans/stage5-web-reader-plan.md`):
   - 5a. ✅ Workspace scaffold + SQLite data layer + upload/import UI +
     book list. Threads and parsed books are imported by uploading the
     two pipeline JSONs at `/upload` (validated against each other —
     mismatched pairs and wrong-slot files get a 400 with a specific
     message); books table stores the thread verbatim as a JSON blob plus
     denormalized counts, chapters are normalized so the reader fetches
     one chapter's text at a time. DB file: `web/data/threadline.db`
     (gitignored). Verified: 15 web tests (`npm run test:web`), root
     tests/tsc untouched and green, `npm run build -w web` clean, real
     Potter's Path import/re-import/wrong-file all behave correctly.
   - 5b. ⬜ Reader view: chapter text alongside a spoiler-gated thread
     panel (Characters tab with per-character relationship drill-in — no
     separate relationships tab — plus a Timeline tab), reading position
     from the URL chapter segment mirrored to localStorage.

Mark stages as complete in this file as they're finished, so future
sessions know where things actually stand.

## Tech stack
- Node.js + TypeScript
- EPUB parsing library (see package.json for the one actually chosen)
- `@anthropic-ai/sdk` for extraction calls
- `dotenv` for API key management (`.env`, never committed)
- Web app (`web/` only): Next.js (App Router) + better-sqlite3. Plain CSS
  modules, no Tailwind/ORM.

## Project structure
- `/src` — extraction pipeline source (pure CLI; no web/DB deps)
- `/web` — the stage-5 web reader (npm workspace; `npm run web` from root)
- `/input` — sample EPUB files (gitignored, not committed)
- `/output` — generated JSON (chapter text, skins) (gitignored, not committed)
- `web/data/threadline.db` — the web app's SQLite file (gitignored)
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)

## Web/pipeline boundary
- `web/` may only `import type { ... } from "@pipeline/types"` (a tsconfig
  path alias to `../src/types.ts`) — **never value imports** from `src/`.
  Type-only imports are erased at compile time; a value import would drag
  the pipeline's node16-CJS code into Next's bundle graph and fail
  confusingly. Web-side runtime constants (role/significance orderings)
  are redeclared in `web/src/lib/constants.ts` on purpose.
- The pipeline never imports from `web/`.

## Conventions
- Every pipeline stage writes its output to `/output` as inspectable JSON
  before the next stage consumes it. No stage should silently pipe output
  straight into the next without a file checkpoint — this is what makes
  it possible to catch a bad parse before burning API budget on it.
- The generated thread JSON file should be named `{bookname}-thread.json`
  (not "skin") to stay consistent with the project's naming.
- Cost awareness: LLM extraction calls cost real money per book (roughly
  $0.20–$2 per book depending on model choice — see project notes/chat
  history for the breakdown). Prefer testing extraction logic on a single
  chapter before running it across a whole book, and a single book before
  running it across a batch.
- Prefer Sonnet for extraction quality/cost balance; only reach for Opus
  if there's a specific reasoning failure Sonnet can't handle. Don't
  default to the most expensive model.

## Guardrails for Claude Code sessions
- Scope each session to one pipeline stage at a time (use `/goal` to hold
  the session to that scope).
- Stage 5 explicitly sanctions a local Next.js app + SQLite **inside
  `web/` only**. The `src/` pipeline stays a pure CLI with no web or DB
  dependencies. Still off-limits everywhere: authentication, deployment,
  multi-user features, EPUB upload into the web app, and LLM calls from
  the web app.
- Don't call the Anthropic API in bulk (e.g. looping over many chapters
  or many books) without confirming with the user first — that's the
  point at which real money gets spent.
- If something looks broken (empty output, malformed JSON, suspiciously
  short chapter text), stop and flag it rather than proceeding to the
  next stage on bad data.