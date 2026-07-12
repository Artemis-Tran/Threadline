# Threadline

A prototype tool that takes an EPUB file and generates a "thread" — a
structured JSON file describing a book's characters, relationships, and
plot events. Threads are precomputed offline by parsing an EPUB into
chapter text and sending chunks to the Claude API for extraction.

This is early-stage scaffolding. Parsing, chunking, and extraction logic
are not implemented yet.

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Copy the env template and add your API key:

   ```
   cp .env.example .env
   ```

   Then edit `.env` and set `ANTHROPIC_API_KEY`.

3. Confirm the project runs:

   ```
   npm start
   ```

   This should print a confirmation message and tell you whether
   `ANTHROPIC_API_KEY` was loaded.

## Scripts

- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run `src/index.ts` directly via `tsx`
- `npm run extract` — placeholder, currently just logs "not implemented yet"

## Project structure

- `/src` — source code
- `/input` — sample EPUB files (gitignored)
- `/output` — generated thread JSON (gitignored)
- `.env` — `ANTHROPIC_API_KEY` (gitignored, never committed)
