# Project: Threadline

## What this is
A prototype tool that takes an EPUB file and generates a "thread" — a
structured JSON file describing a book's characters, relationships, and
plot events. The thread is built by parsing the EPUB into chapter text,
then sending chunks to the Claude API to extract structured entities.

The gist is to precompute these "threads" offline and match them to books a
user uploads, rather than running extraction live on arbitrary uploads.
The offline extraction pipeline (stages 1–4) is complete; stage 5 is a
static, client-only web app (`web/`) — a browsable "mini-wiki" that stores
thread JSONs in the browser (IndexedDB) and displays them, hosted on
GitHub Pages.

## Current stage
The extraction pipeline (stages 1–4) is done. Stage 5 pivoted from a
Next.js + SQLite "web reader" to a **static, client-only wiki SPA**
(Vite + React + IndexedDB) hosted on GitHub Pages — see
`plans/stage5-static-wiki-plan.md`, which supersedes
`plans/stage5-web-reader-plan.md`. It's split into 5-A (data/persistence
core), 5-B (library shell), 5-C (wiki view), and 5-D (ship). Each stage is
built, Codex-reviewed (`/review-git-diff`), and validated independently
before moving on. Check with the user before jumping ahead, even if the
next step seems obvious.

Pipeline stages, in order:
1. ✅ EPUB parsing → clean chapter text (`src/parse-epub.ts`)
2. ✅ Single-chapter test extraction (one API call, inspect raw output) (`src/extract-chapter.ts`, verified on chapter 8)
3. ✅ Full chunking + per-chunk extraction with running context
   (`src/extract-book.ts`; verified on The Potter's Path — 47 chunks in
   `output/{slug}-chunks/`. Character names in that first run were
   repaired by a mechanical cleanup pass, marked `meta.postProcessed`
   in each chunk; the roster-contamination bug that caused it is fixed
   in the script, so future books won't need it.
   The extraction model is configurable via `--model <id>` on
   `extract-book`/`extract-chapter`/`book` (default `claude-sonnet-5`;
   shorthands `sonnet`/`haiku`/`opus`). The registry + per-model pricing
   live in `src/models.ts` and act as an allowlist, so the cost gate and
   manifest stay honest and an unpriced/misspelled model is rejected
   before any API call. `extract-book` also takes `--out-dir <path>` to
   redirect the chunks output, and a cross-model guard refuses to reuse
   one model's cached checkpoints under a different `--model` (fails
   closed before spending). `src/compare-extractions.ts`
   (`npm run compare-extractions -- <dirA> <dirB>`) A/B-diffs two chunk
   dirs — per-chapter counts, roster differences, and each run's real
   cost (priced from summed per-chunk usage, so resumed/rebuilt runs are
   accurate). A Haiku-vs-Sonnet A/B on The Potter's Path found Haiku
   ~7× cheaper ($0.54 vs $3.95) but noisier — background walk-ons
   promoted to characters and more name fragmentation
   (e.g. `Merrick` split from `Davos Merrick`), which loads the
   merge/identity stage — so Sonnet stays the default; a prompt tweak
   suppressing unnamed background figures is the untried lever if Haiku's
   cost is wanted.
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
5. Static wiki SPA (`web/` npm workspace: Vite + React + IndexedDB via
   `idb`; no server, no SQLite; plan in `plans/stage5-static-wiki-plan.md`,
   which supersedes the old reader plan). A browsable "mini-wiki" for a
   book: the centerpiece is a **chapter cap** ("world as of chapter N")
   over spoiler-gated Characters (with per-character relationship drill-in)
   and a Timeline — all recomputed from the thread's historical records
   filtered to `chapterIndex <= cap` (never the whole-book top-level
   fields). Thread-only: the parsed-book prose import was dropped. The
   library and per-book UI state (last-opened book, chapter-cap position,
   active tab) persist in the browser (IndexedDB), with a JSON export/
   import for backup/portability. Deferred ideas are tracked in
   `plans/deferred-ideas.md`.
   - 5-A. ✅ Scaffold swap (Next+SQLite → Vite+React+idb), thread-only
     validator, IndexedDB layer (library/prefs + versioned export/import),
     pure spoiler-safe `asOf.ts` cap selectors. 45 web tests.
   - 5-B. ✅ Library shell: HashRouter, drag-drop/file-picker thread
     import, per-book delete, whole-library export/import.
   - 5-C. ✅ Wiki view: chapter-cap slider, Characters/Timeline tabs,
     search, per-character drill-in with relationship cross-links; cap/
     tab/character synced to the URL and to per-book IndexedDB prefs.
     The Timeline later gained a List/"Story map" sub-tab pair (`tl` URL
     param + optional-additive `timelineView` pref): a vertical storyline
     chart (pure layout engine in `web/src/lib/storymap.ts` — greedy
     block-pull + bounded crossing refinement, unit-tested) with up to 5
     role-auto-selected, user-adjustable character lanes, majors-only
     default with per-chapter "+N more" expanders, orphan events on the
     chapter rail, and a click-for-detail panel. See
     `plans/timeline-story-map-plan.md`.
   - 5-D. ✅ Ship: GitHub Actions workflow (`.github/workflows/deploy.yml`)
     builds `web/` and deploys to GitHub Pages on push to `master`. One
     manual step remains outside the repo: enable Pages with Source =
     "GitHub Actions" (Settings → Pages). Site URL:
     `https://artemis-tran.github.io/Threadline/` (base path `/Threadline/`
     in `vite.config.ts`, overridable via `THREADLINE_BASE`).

Mark stages as complete in this file as they're finished, so future
sessions know where things actually stand.

## Tech stack
- Node.js + TypeScript
- EPUB parsing library (see package.json for the one actually chosen)
- `@anthropic-ai/sdk` for extraction calls
- `dotenv` for API key management (`.env`, never committed)
- Web app (`web/` only): Vite + React + react-router-dom (HashRouter),
  persistence via IndexedDB (`idb`). Plain CSS modules, no Tailwind. No
  server, no SQLite/ORM. Deployed as a static site to GitHub Pages.

## Project structure
- `/src` — extraction pipeline source (pure CLI; no web/DB deps)
- `/web` — the stage-5 static wiki SPA (Vite; npm workspace; `npm run web`
  from root for the dev server, `npm run build -w web` → `web/dist`)
- `.github/workflows/deploy.yml` — builds `web/` and publishes it to
  GitHub Pages on push to `master`
- `/input` — sample EPUB files (gitignored, not committed)
- `/output` — generated JSON (chapter text, skins) (gitignored, not committed)
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)

## Web/pipeline boundary
- `web/` may only `import type { ... } from "@pipeline/types"` (a tsconfig
  path alias to `../src/types.ts`) — **never value imports** from `src/`.
  Type-only imports are erased at compile time; a value import would drag
  the pipeline's node16-CJS code into the web bundle graph and fail
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
- The extraction model is selectable via `--model` (see stage 3);
  default and recommended is Sonnet for the quality/cost balance. Cheaper
  models (Haiku) work but produce noisier rosters — A/B with
  `compare-extractions` before switching a book. Only reach for Opus if
  there's a specific reasoning failure Sonnet can't handle. Don't default
  to the most expensive model.

## Guardrails for Claude Code sessions
- Scope each session to one pipeline stage at a time (use `/goal` to hold
  the session to that scope).
- Stage 5 sanctions a **static Vite + React SPA with IndexedDB inside
  `web/` only**, deployed as a **static site to GitHub Pages** (client-only
  — the deploy just publishes prebuilt files; there is no server/backend).
  The `src/` pipeline stays a pure CLI with no web or DB dependencies.
  Still off-limits everywhere: authentication, **server/backend
  deployment** (only static client hosting is allowed), multi-user
  features, EPUB upload into the web app, and LLM calls from the web app.
- Don't call the Anthropic API in bulk (e.g. looping over many chapters
  or many books) without confirming with the user first — that's the
  point at which real money gets spent.
- If something looks broken (empty output, malformed JSON, suspiciously
  short chapter text), stop and flag it rather than proceeding to the
  next stage on bad data.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `Artemis-Tran/Threadline`, via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim as label strings.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.