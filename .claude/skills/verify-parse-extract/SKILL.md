---
name: verify-parse-extract
description: Use this skill after running the EPUB parsing step (parse-epub.ts) or the LLM extraction step to verify the output is actually correct before trusting it or moving to the next pipeline stage. Triggers whenever a {bookname}-parsed.json or a skin/extraction JSON file has just been generated and needs a quality check, or when the user asks to "verify parsing," "check the extraction," or "sanity check the output."
---

# Verify Parsing & Extraction Output

Parsing an EPUB or running an LLM extraction can fail silently — the script
exits with code 0 and produces a JSON file, but the content inside is
garbage (empty chapters, mangled encoding, HTML tags that didn't strip,
truncated text, duplicate chunks, hallucinated entities). This skill checks
for those failure modes explicitly rather than eyeballing the file.

Always report findings as a pass/fail checklist with specific evidence
(chapter numbers, line counts, sample snippets) — never just say "looks
good" without showing the numbers that back it up.

## Stage 1: Parsing output ({bookname}-parsed.json)

The file is a single object, not a top-level array: `{sourceFile, title,
creator, language, chapterCount, wordCount, chapters}`. The chapter list
lives under `chapters`, and each entry has `index`, `id`, `href`, `title`,
`wordCount`, and `text` fields (no `chapterIndex` — use `index`).

Read the JSON file and check each of these. For any failure, quote the
specific chapter `index` and a short snippet as evidence.

1. **Valid structure** — file parses as JSON; top-level object has
   `sourceFile`, `title`, `creator`, `language`, `chapterCount`,
   `wordCount`, and a non-empty `chapters` array; every entry in
   `chapters` has `index`, `title`, and `text` fields.

2. **Chapter count sanity** — flag if `chapterCount`/`chapters.length` is
   only 1 (spine probably wasn't read correctly) or a suspiciously huge
   number (e.g. 100+, which often means the parser split on every `<p>`
   tag instead of per-chapter file). Confirm `chapterCount` matches the
   actual length of `chapters`.

3. **No leftover markup** — grep each chapter's `text` for `<`, `&nbsp;`,
   `&amp;`, `&#`, or other HTML/entity remnants. Any hits mean the tag
   stripping step is incomplete.

4. **No encoding corruption** — scan for mojibake patterns (e.g. `â€™`,
   `Ã©`, repeated `�` replacement characters). These indicate the file
   was read with the wrong encoding.

5. **Empty or near-empty chapters** — flag any chapter under ~50 words
   (`wordCount` field). Front matter (title page, copyright, dedication)
   is expected to be short — call those out by name/position rather than
   treating them as bugs. But a mid-book chapter under 50 words is a red
   flag.

6. **Word count sanity** — sum the per-chapter `wordCount` fields and
   confirm it matches the top-level `wordCount`. Compare the total to a
   plausible novel length (roughly 40k-150k words for a typical novel;
   less for novellas). Report the total either way so the user can judge
   for their specific book.

7. **Duplicate content** — check whether any two chapters have near-
   identical text (e.g. first 300 characters match). This usually means
   the spine was read with repeated entries or the parser looped.

8. **Sequential ordering** — confirm `index` values run 0..N-1 with no
   gaps or repeats. Note: `title` comes from the EPUB flow item and is
   commonly `null` for every chapter (the underlying `epub2` library
   doesn't populate titles on flow entries — they'd need to come from
   the TOC/NCX instead). All-null titles are a known library limitation,
   not a parsing bug — don't flag it as FAIL, just note it as INFO if
   the user may want titles for a later stage. If titles *are* present,
   check they read as a plausible in-order sequence (not, say, "Chapter
   12" appearing before "Chapter 2").

Report format for this stage:
```
PARSING CHECK: {filename}
[PASS/FAIL] Valid structure — N chapters found under `chapters`
[PASS/FAIL] Chapter count sane — N chapters (chapterCount matches chapters.length)
[PASS/FAIL] No leftover HTML/entities — {details if failed}
[PASS/FAIL] No encoding corruption — {details if failed}
[PASS/FAIL] No suspiciously empty chapters — {list any, with word counts}
[INFO] Total word count: N (expected range: 40k-150k for a novel)
[PASS/FAIL] No duplicate chapters — {details if failed}
[PASS/FAIL] Sequential ordering — {details if failed}
[INFO] Chapter titles: {"all null (expected — epub2 flow items don't carry titles)" or list any present}
```

## Stage 2: LLM extraction output (thread JSON)

Once an extraction pass (character/plot JSON from the Claude API) has
run, check separately — parsing being correct doesn't mean extraction is:

1. **Valid JSON** — the LLM output actually parses; if not, show the raw
   text that failed and where it likely broke (truncated output, stray
   markdown fences, trailing comma).

2. **Schema conformance** — every character/entity entry has the expected
   fields (e.g. name, first appearance chapter, description). Flag any
   entries missing required fields.

3. **Duplicate entity detection** — look for near-duplicate character
   names that are likely the same person split into two entries (e.g.
   "Bob" and "Robert", "Ms. Chen" and "Sarah Chen"). List suspected pairs
   for human review rather than silently merging them.

4. **Chapter references are in range** — any "first appearance" or
   "event occurs in chapter N" reference should point to a chapter that
   actually exists in the parsed book. Flag out-of-range references —
   these usually mean the LLM hallucinated or miscounted.

5. **Spoiler-order sanity** — if the schema tracks "first appearance,"
   confirm no character's first-appearance chapter is later than an
   event they're described as participating in in the same chapter's
   summary (a common ordering bug when chunks are processed out of
   order or merged incorrectly).

Report format for this stage:
```
EXTRACTION CHECK: {filename}
[PASS/FAIL] Valid JSON
[PASS/FAIL] Schema conformance — {N entries missing fields, if any}
[INFO] Possible duplicate entities: {list pairs, or "none found"}
[PASS/FAIL] Chapter references in range — {list any out-of-range refs}
[PASS/FAIL] No spoiler-order anomalies — {details if found}
```

## What this skill does NOT do

- Does not fix the issues automatically — surface them clearly and let
  the user (or a follow-up prompt) decide how to fix the underlying
  script.
- Does not judge extraction *quality* (e.g. whether a character
  description is well-written) — only structural/factual correctness.
- Does not re-run the parsing or extraction scripts itself unless
  explicitly asked to.