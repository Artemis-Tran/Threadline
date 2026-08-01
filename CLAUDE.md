# Project: Threadline

A prototype that turns an EPUB into a **thread** — structured JSON describing a
book's characters, relationships, and events, indexed by chapter. An offline
CLI pipeline builds threads; a static web app browses them.

**Read `CONTEXT.md` first** for the domain vocabulary, and the ADRs in
`docs/adr/` before working in an area they cover. Use the glossary's terms in
code, issues, and tests rather than drifting to synonyms.

## Where things stand

Pipeline stages 1–4 are complete and stage 5 has shipped. All five are
verified against The Potter's Path.

1. ✅ EPUB parsing → clean chapter text (`src/parse-epub.ts`)
2. ✅ Single-chapter extraction, for eyeballing raw output (`src/extract-chapter.ts`)
3. ✅ Per-chapter extraction with a running roster (`src/extract-book.ts`)
4. ✅ Merge/dedupe across chapter extracts (`src/merge-thread.ts`) — writes
   `output/{slug}-thread.json`
5. ✅ Static wiki SPA (`web/`) — chapter-cap browsing over Characters and a
   Timeline, deployed to GitHub Pages

Keep this list current as things change, so future sessions know where the
work actually stands.

## Commands

```
npm run parse                 # stage 1
npm run extract               # stage 2, single chapter
npm run extract-book          # stage 3
npm run merge-thread          # stage 4
npm run book                  # stages 1–4 end to end
npm run compare-extractions -- <dirA> <dirB>   # A/B two extraction runs
npm test                      # pipeline tests
npm run web                   # web dev server
npm run test:web              # web tests
npm run build -w web          # → web/dist
```

Notable flags: `--model <id>` on the extraction commands (default
`claude-sonnet-5`; shorthands `sonnet`/`haiku`/`opus`/`luna`/`terra`),
`--out-dir <path>` on `extract-book`, and `--progression-order <path>` on
`merge-thread`.

`src/models.ts` is the model allowlist, pricing table, and the authority on
which vendor serves a row. An unpriced or misspelled model is rejected before
any API call, and reusing one model's cached extracts under a different
`--model` fails closed.

`luna`/`terra` are OpenAI GPT-5.6 rows and run on **stage 2 only** — stage 3
still has its own Anthropic call path and rejects a non-Anthropic model up
front. Neither is a default; Sonnet still is (ADR-0004), and Luna's extraction
quality is unmeasured. Both need `OPENAI_API_KEY`; the credential check is
provider-derived, so an Anthropic run never asks for one.

## Tech stack

- Node.js + TypeScript, `tsx` to run, `epub2` for EPUB parsing
- `@anthropic-ai/sdk` and `openai` for extraction, both used only behind
  `src/extraction-call.ts`; `dotenv` for the API keys
- Web (`web/` only): Vite + React + react-router-dom (HashRouter), IndexedDB
  via `idb`, plain CSS modules. No Tailwind, no server, no SQLite/ORM.

## Project structure

- `/src` — extraction pipeline (pure CLI, no web or DB deps)
- `/web` — the static wiki SPA (npm workspace)
- `.github/workflows/deploy.yml` — builds `web/`, publishes to GitHub Pages on
  push to `master`. Live at https://artemis-tran.github.io/Threadline/
  (base path `/Threadline/` in `vite.config.ts`, overridable via
  `THREADLINE_BASE`)
- `/input`, `/output`, `.env` — all gitignored, never committed

## Conventions

- Every stage writes inspectable JSON to `/output` before the next stage reads
  it — never pipe one stage straight into the next (ADR-0006).
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

- Scope each session to one pipeline stage. Check before jumping ahead, even
  when the next step seems obvious.
- Don't call the Anthropic API in bulk — looping over many chapters or many
  books — without confirming first. That's where real money gets spent.
- If output looks broken (empty, malformed JSON, suspiciously short chapter
  text), stop and flag it rather than running the next stage on bad data.
- Off-limits everywhere: authentication, any server or backend (static client
  hosting only), multi-user features, EPUB upload into the web app, and LLM
  calls from the web app. See ADR-0002 for why these aren't merely unbuilt.
- Each stage of work is built, reviewed, and validated
  before moving on.

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
