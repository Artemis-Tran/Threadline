# Project: Threadline

## What this is
A prototype tool that takes an EPUB file and generates a "thread" — a
structured JSON file describing a book's characters, relationships, and
plot events. The thread is built by parsing the EPUB into chapter text,
then sending chunks to the Claude API to extract structured entities.

The gist is to precompute these "threads" offline and match them to books a
user uploads, rather than running extraction live on arbitrary uploads.
We're building the offline extraction pipeline first — a live reader UI
is a later, separate concern.

## Current stage
We are early: parsing + verification. **Do not build the LLM extraction
step, chunking logic, entity merging, or any reader UI until explicitly
asked.** Each pipeline stage is being built and validated independently
before moving to the next one. Check with the user before jumping ahead,
even if the next step seems obvious.

Pipeline stages, in order:
1. ✅ EPUB parsing → clean chapter text (`src/parse-epub.ts`)
2. ✅ Single-chapter test extraction (one API call, inspect raw output) (`src/extract-chapter.ts`, verified on chapter 8)
3. ⬜ Full chunking + per-chunk extraction with running context
4. ⬜ Entity merge/dedupe pass across chunks
5. ⬜ Reader UI to display a thread alongside book text

Mark stages as complete in this file as they're finished, so future
sessions know where things actually stand.

## Tech stack
- Node.js + TypeScript
- EPUB parsing library (see package.json for the one actually chosen)
- `@anthropic-ai/sdk` for extraction calls
- `dotenv` for API key management (`.env`, never committed)

## Project structure
- `/src` — all source code
- `/input` — sample EPUB files (gitignored, not committed)
- `/output` — generated JSON (chapter text, skins) (gitignored, not committed)
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)

## Conventions
- Every pipeline stage writes its output to `/output` as inspectable JSON
  before the next stage consumes it. No stage should silently pipe output
  straight into the next without a file checkpoint — this is what makes
  it possible to catch a bad parse before burning API budget on it.
- The generated thread JSON file should be named `{bookname}-thread.json`
  (not "skin") to stay consistent with the project's naming.
- Use the `verify-parse-extract` skill after running the parser or an
  extraction pass, before trusting the output or building on top of it.
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
- Don't add authentication, a database, a web server, or a UI framework
  unless a stage explicitly calls for it — this is a local CLI pipeline
  for now.
- Don't call the Anthropic API in bulk (e.g. looping over many chapters
  or many books) without confirming with the user first — that's the
  point at which real money gets spent.
- If something looks broken (empty output, malformed JSON, suspiciously
  short chapter text), stop and flag it rather than proceeding to the
  next stage on bad data.