# Project: Threadline

A prototype that turns an EPUB into a **thread** — structured JSON describing a
book's characters, relationships, and events, indexed by chapter. An offline
CLI pipeline builds threads; a static web app browses them.

**Read `CONTEXT.md` first** for the domain vocabulary, and the ADRs in
`docs/adr/` before working in an area they cover. Use the glossary's terms in
code, issues, and tests rather than drifting to synonyms.

## Where things stand

There is a **three-step pipeline**, two **tools** beside it, and an
**application**. All of it is shipped and verified against The Potter's Path.

The pipeline — what `npm run book` chains, and what it announces as `[1/3]`,
`[2/3]`, `[3/3]`:

1. ✅ **Parse** — EPUB → clean chapter text (`src/parse-epub.ts`)
2. ✅ **Extract** — per-chapter extraction with a running roster
   (`src/extract-book.ts`) → `output/{slug}-chunks/`. Runs on either provider,
   through the call seam in `src/extraction-call.ts`
3. ✅ **Merge** — dedupe across chapter extracts (`src/merge-thread.ts`) →
   `output/{slug}-thread.json`

The tools, neither of which is a pipeline step:

- ✅ **Single-chapter probe** (`src/extract-chapter.ts`) — extract one chapter
  and eyeball it before paying for a book. A thin wrapper: it translates a
  chapter index into a one-chapter extraction window and spawns the extract
  step, so the probe shares its schema, prompt, roster, and cost gate
- ✅ **A/B comparison** (`src/compare-extractions.ts`) — diff and price two
  extraction-run directories

The application:

- ✅ **Static wiki SPA** (`web/`) — chapter-cap browsing over Characters and a
  Timeline, deployed to GitHub Pages

Keep this list current as things change, so future sessions know where the
work actually stands.

## Commands

```
npm run book                  # the whole pipeline: parse → extract → merge
npm run parse                 # pipeline step 1
npm run extract-book          # pipeline step 2
npm run merge-thread          # pipeline step 3
npm run extract               # tool: single-chapter probe
npm run compare-extractions -- <dirA> <dirB>   # tool: A/B two extraction runs
npm test                      # pipeline tests
npm run web                   # web dev server
npm run test:web              # web tests
npm run build -w web          # → web/dist
```

Notable flags: `--model <id>` on the extraction commands (default
`claude-sonnet-5`; shorthands `sonnet`/`haiku`/`opus`/`luna`/`terra`),
`--list`, `--out-dir <path>` and `--roster <path>` on `extract-book`, and
`--progression-order <path>` on `merge-thread`.

`npm run extract -- <parsed-json> <index|--list> [--model <id>] [--roster
<path>]` is a translator, not a second extraction path. An index becomes
`--from N --to N --force N` into `output/{slug}-probe-{model}/`, and
`extract-book` is spawned with inherited stdio so its cost-confirmation prompt
reaches the terminal. Consequences worth knowing: a probe goes through the cost
gate, always re-extracts (the gate is the only guard against paying twice),
writes a manifest the A/B comparison tool can read, and can never touch a
book's real `{slug}-chunks/` directory. `--list` maps array indices to chapter
titles, makes no API call, and is free.

`--roster` takes a JSON array of roster entries (the shape of a manifest's
`roster` field) and starts the run from it instead of accumulating one by
replaying earlier chapters. It exists so a single-chapter run can be handed a
deliberately adversarial roster and answer "does this model reuse a roster
entry's name verbatim?" in one paid call. Entries are used verbatim — none of
`updateRoster`'s normalization is applied — and a missing, unparseable, or
wrong-shaped file aborts before any API call. It cannot be combined with
`--rebuild-manifest`, whose roster must stay derived from the chapter extracts
on disk. A seeded run records `rosterPath` in its manifest `meta`.

`src/models.ts` is the model allowlist, pricing table, and the authority on
which vendor serves a row. An unpriced or misspelled model is rejected before
any API call, and reusing one model's cached extracts under a different
`--model` fails closed.

`luna`/`terra` are OpenAI GPT-5.6 rows and are runnable: `extract-book` goes
through `src/extraction-call.ts`, which owns both vendors' request shapes, so
the probe and a book run both reach OpenAI. Neither is a default; Sonnet still
is (ADR-0004), and Luna's extraction quality beyond a single probed chapter is
unmeasured. Reasoning effort is pinned in the seam rather than exposed as a
flag, so the registry's output estimate is always sized against a known effort
level (ADR-0008).

## Tech stack

- Node.js + TypeScript, `tsx` to run, `epub2` for EPUB parsing
- `@anthropic-ai/sdk` and `openai` for extraction, behind the call seam in
  `src/extraction-call.ts` — the only place either SDK is constructed, and the
  only extraction path there is (ADR-0008); `dotenv` for the API keys
- Web (`web/` only): Vite + React + react-router-dom (HashRouter), IndexedDB
  via `idb`, plain CSS modules. No Tailwind, no server, no SQLite/ORM.

## Project structure

- `/src` — extraction pipeline (pure CLI, no web or DB deps)
- `/web` — the static wiki SPA (npm workspace)
- `/scripts` — one-off migrations over `/output`, run by hand with `tsx` and
  kept as the record of what was done to paid output. Not pipeline source, not
  typechecked by `npm run build`, no npm script. Each is dry-run by default
- `.github/workflows/deploy.yml` — builds `web/`, publishes to GitHub Pages on
  push to `master`. Live at https://artemis-tran.github.io/Threadline/
  (base path `/Threadline/` in `vite.config.ts`, overridable via
  `THREADLINE_BASE`)
- `/input`, `/output`, `.env` — all gitignored, never committed

## Conventions

- Every pipeline step writes inspectable JSON to `/output` before the next step
  reads it — never pipe one step straight into the next (ADR-0006).
- The merged output is `{bookname}-thread.json`. "Skin" is dead legacy naming.
- **Naming drift, known and accepted:** the canonical term is *chapter
  extract*, but the directory is `{slug}-chunks/`, the files are
  `idx###-extract.json`, and the code says `checkpoint`. Don't rename them —
  the churn isn't worth it. Just don't spread "chunk" into new code or docs.
- Cost awareness: extraction costs real money per book. Test on one chapter
  before a whole book, and one book before a batch. Sonnet is the default and
  the recommendation (ADR-0004) — don't reach for Opus without a specific
  reasoning failure Sonnet can't handle.
- `web/` may only `import type` from `@pipeline/types`; never value imports
  (ADR-0003). The pipeline never imports from `web/`.
- Progression-order regression detection is regex-based with no subject
  attribution, so it produces occasional false positives — a description that
  mentions another character's rank can be flagged against the wrong person.
  Expect this; don't chase it with ad hoc regex tweaks.

## Guardrails

- Don't call the Anthropic API in bulk — looping over many chapters or many
  books — without confirming first. That's where real money gets spent.
- If output looks broken (empty, malformed JSON, suspiciously short chapter
  text), stop and flag it rather than running the next step on bad data.
- Off-limits everywhere: authentication, any server or backend (static client
  hosting only), multi-user features, EPUB upload into the web app, and LLM
  calls from the web app. See ADR-0002 for why these aren't merely unbuilt.
- Each piece of work is built, reviewed, and validated before moving on. Scope
  a session to a real boundary — a pipeline step, a tool, the web app, or a
  seam between them — not to a stage number. Work that changes how extraction
  calls a vendor touches the extract step and the probe together, because they
  were never two separate things.

## Deferred work

Tracked work lives on the issue tracker. Everything else sits in
`plans/deferred-ideas.md` and `plans/system-data-schema-plan.md` — roughly
eight parked ideas, mostly a single-file HTML thread export, a whole-book
relationship graph, prose search, and library-scaling polish.

**`plans/` is gitignored**, so those exist on one machine only and are not
readable from a clone. Treat them as stale until checked: known-wrong entries
include a theme toggle listed as unbuilt (it shipped) and a chapter-numbering
heuristic that was never implemented. Verify against the code before acting on
anything in there, and move an idea to the tracker when it gets picked up.

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
