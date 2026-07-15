# Architecture Deep Dive: Stage 3 (Extraction) & Stage 4 (Merge)

Reference doc for explaining, in depth, how the two core pipeline stages
actually work — not just their inputs/outputs, but the algorithms,
data structures, and design tradeoffs inside them. Written from the
current implementation in `src/extract-book.ts`, `src/merge-thread.ts`,
`src/identity.ts`, and `src/types.ts`.

---

## 1. System overview

Threadline's pipeline is a sequence of **file-checkpointed CLI scripts**,
not a single program. Each stage reads a file, does its work, and writes
a file — nothing pipes directly from one stage's memory into the next.

```
EPUB file
   │  (stage 1: parse-epub.ts)
   ▼
{slug}-parsed.json               (ParsedBook: chapters of clean text)
   │  (stage 3: extract-book.ts) ── paid, per-chapter Claude API calls
   ▼
{slug}-chunks/
  ├─ idx004-extract.json         (one Extraction per narrative chapter)
  ├─ idx005-extract.json
  ├─ ...
  └─ manifest.json                (Manifest: run metadata + roster hint)
   │  (stage 4: merge-thread.ts) ── free, deterministic, local-only
   ▼
{slug}-thread.json                (Thread: deduped characters/relationships/events)
```

**Why split stage 3 and stage 4 into separate processes instead of one
"extract and merge" script?**

- **Cost boundary.** Stage 3 is the only stage that spends money (Claude
  API calls, ~$0.20–$2/book). Stage 4 is pure computation over already-paid-for
  JSON. Keeping them separate means re-running merge logic — to fix a bug,
  tune the tier-conflict heuristic, whatever — never re-triggers spend.
  You can delete `{slug}-thread.json` and regenerate it a hundred times for
  free; you cannot do that with the chunk files.
- **Resumability.** Book-length extraction is dozens of sequential API
  calls against a large document; it *will* get interrupted (rate limits,
  network errors, a bad chapter). Stage 3 checkpoints after every single
  chapter so a crash only costs the in-flight call, and the next run
  resumes from disk instead of restarting the book. A merged thread has no
  such natural per-unit checkpoint to resume from, so it doesn't need this
  machinery — it just reads everything and computes once.
- **Verifiability at a checkpoint.** Per the project convention (see root
  `CLAUDE.md`), every stage writes an inspectable JSON file before the next
  stage consumes it. A bad extraction is visible in `idxNNN-extract.json`
  before it ever reaches the merge; a bad merge is visible in
  `{slug}-thread.json` before it would reach a reader UI (stage 5, not yet
  built).
- **Different correctness models.** Stage 3's output is inherently
  probabilistic (an LLM's read of one chapter). Stage 4 is deterministic
  code over that output — same chunks in, same thread out, every time.
  Mixing them would make the deterministic part harder to test in
  isolation (it currently has no dependency on `ANTHROPIC_API_KEY` or
  network access at all).

Both stages share one module, **`src/identity.ts`**, which holds the
character name/alias matching logic. This exists because stage 3's roster
hint and stage 4's authoritative merge need the *same* notion of "is this
the same character," and having two independent implementations would let
them silently drift apart over time (e.g., stage 3 treats two names as the
same person but stage 4 doesn't, or vice versa).

---

## 2. Stage 3 — `extract-book.ts`: chunked extraction with running context

### 2.1 What it actually does, end to end

For a parsed book, walk every chapter in order. For each one, decide if
it's narrative (vs. front/back matter) and whether this run should call
the API for it. If yes, send the chapter text to Claude along with a
**system prompt containing a "roster" of characters seen so far**, get back
a schema-constrained JSON extraction (characters/relationships/events),
write it to a checkpoint file, and fold its characters into the roster for
the *next* chapter's prompt. Whether extracted or loaded from an existing
checkpoint, every narrative chapter's characters update the roster — so
the roster reflects the whole book's cast by the end, regardless of which
chapters were (re-)extracted in a given invocation.

### 2.2 Chapter classification — `planChapters()`

```ts
export function planChapters(book: ParsedBook, opts: CliOptions, chunksDir: string): ChapterPlan[]
```

Every chapter gets a `ChapterPlan`: `{ chapter, narrative, skipReason,
hasCheckpoint, willExtract }`. Two independent judgments happen here:

1. **Is this chapter narrative at all?** A chapter is excluded from the
   thread entirely (`skipReason`) if it's under `MIN_NARRATIVE_WORDS`
   (300) *or* its title matches `NON_NARRATIVE_TITLE` (a regex for
   "contents|foreword|dedication|afterword|acknowledg|about the
   author|copyright|epigraph"). Word count alone was tried and found
   insufficient — this book's afterword is 419 words, comfortably over
   the threshold, so the title check catches what length can't.
2. **Should *this run* pay to (re-)extract it?** Independent of
   narrative-ness: an explicit `--force <indices>` always wins (bypasses
   `--from/--to/--skip` and even the narrative check). Otherwise a chapter
   is extracted if it's narrative, inside the `--from/--to` window, not in
   `--skip`, and either `--force` (bare, forces all) is set or it has no
   existing checkpoint yet.

This two-axis design is what lets you do things like "re-extract just
chapter 12 because the model flubbed it" (`--force 12`) without touching
anything else, or "extract chapters 30–47 only" while chapters 1–29 still
feed the roster from their cached checkpoints.

### 2.3 The roster — a naming-consistency hint, not identity resolution

This is the part worth being precise about in an interview, because it's
easy to conflate with stage 4's merge and they solve different problems.

```ts
export function updateRoster(roster: RosterEntry[], characters: ExtractedCharacter[], chapterIndex: number): void
```

**Problem it solves:** the model extracts each chapter independently, with
no memory of prior chapters. Without help, it might call the protagonist
"Henry" in chapter 4, "Henry Ashford" in chapter 5, and "the Mystic Potter"
in chapter 9 — three names for one person, with nothing downstream able to
tell they're the same character. The roster is injected into the *next*
chapter's system prompt (`buildSystemPrompt()`) as a "characters known so
far" list, telling the model: if you see this person again, call them
exactly this.

**How matching works:** `findIdentityMatch()` (from `identity.ts`) treats a
new character as the same as an existing roster entry if there's *any*
case-insensitive overlap between the new name+aliases and the known
name+aliases — including a bare name match. This is a deliberate,
documented tradeoff: real characters accumulate many non-overlapping
aliases across a book ("Henry Ashford" / "Young Master Ashford" / "the
Mystic Potter"), so requiring alias overlap would fragment one character
into many roster entries. The accepted cost is the rarer opposite failure
— two genuinely different characters who happen to share a bare name get
merged into one roster entry. That's explicitly left unresolved here and
punted to stage 4, which has much richer signal (full per-chapter
descriptions, co-occurrence, relationships) to eventually disambiguate it.

**Why the roster is lossy on purpose:** each entry caps at
`ROSTER_MAX_ALIASES` (8) and truncates `description` to
`ROSTER_DESCRIPTION_MAX_CHARS` (150). It only needs to be good enough for
the model to recognize a name it already used — not a faithful record of
everything known about the character. Stage 4 never trusts this roster as
ground truth; it rebuilds a full history straight from the chunk files.

**The bug this file's comments call out:** description merging is
"longest string wins" —

```ts
const newDescription = c.description.slice(0, ROSTER_DESCRIPTION_MAX_CHARS);
if (newDescription.length > target.description.length) target.description = newDescription;
```

— which means a short, terse chapter-50 description won't replace a long,
detailed chapter-5 one, even though the chapter-50 one is more recent and
potentially corrects something. This is fine for the roster's actual job
(naming hints), but it's the literal bug named in the project's stage-4
task notes as something the *merge* pass needed to fix properly (which it
does — see §3.4, recency-first).

### 2.4 The extraction call — `extractChapter()`

```ts
async function extractChapter(client, book, chapter, roster, outPath):
  Promise<{ extraction: Extraction; usage: Anthropic.Usage }>
```

Calls `client.messages.create()` with:
- `system`: `buildSystemPrompt(book.title, roster)` — instructions plus
  the roster hint list.
- `messages`: the raw chapter text as the single user turn.
- `output_config.format`: `{ type: "json_schema", schema: EXTRACTION_SCHEMA }`
  — the response is constrained to a strict JSON Schema (`characters`,
  `relationships`, `events`, each with `additionalProperties: false`), so
  the model can't return malformed shapes.

Three distinct failure paths are handled explicitly, each preserving
evidence instead of silently losing it:
- `stop_reason === "refusal"` → throw immediately (nothing to salvage).
- `stop_reason === "max_tokens"` → the (incomplete) text is dumped to a
  sibling `*-truncated.txt` file before throwing, so a truncation is
  inspectable rather than silently dropped.
- Response text isn't valid JSON despite the schema constraint → dumped to
  `*-raw.txt` before throwing, same reasoning.

On success, it writes a checkpoint file containing both the raw
`extraction` and a `meta` block (model, chapter identity, the *exact*
system prompt used, token usage, timestamp) — the system prompt is saved
per-checkpoint specifically so you can later see exactly what roster state
was visible to the model when it produced that chapter's output.

### 2.5 Checkpointing, resumability, and partial-failure handling

- `checkpointPath(chunksDir, index)` → `idx004-extract.json` (zero-padded
  index — keeps directory listings in chapter order).
- The main run loop (`processChapters()`) accumulates `roster`,
  `manifestChapters`, and `totals` (token/cost counters) in variables owned
  by `main()`, specifically so that **if extraction throws partway
  through**, everything accumulated so far is still available to persist.
- On failure, `main()` writes a `manifest.partial.json` (not overwriting
  `manifest.json`) with `complete: false`, then re-throws. This means a
  half-finished run never corrupts a previously-good, complete manifest —
  stage 4 refuses to run against an incomplete manifest (§3.2), so a
  partial run can't accidentally get merged as if it were whole.
- Rerunning the same command resumes for free: chapters with existing
  checkpoints are loaded (`readCheckpointCharacters()`) to rebuild the
  roster without spending another API call, and only chapters still
  missing a checkpoint (or explicitly `--force`d) get extracted.
- `--rebuild-manifest` is a fully read-only mode (`client === null`
  throughout `processChapters`) — it replays every existing checkpoint to
  regenerate `manifest.json` and the roster from scratch, with zero API
  calls. Useful if the manifest itself gets corrupted but the chunk files
  are intact.

### 2.6 Cost gating

`estimateCostUsd()` projects cost *before* any call is made, using a rough
per-word token estimate (`EST_TOKENS_PER_WORD = 2.7`) plus a fixed prompt
overhead, at Sonnet's published per-token rates. This estimate is shown to
the user, who must either pass `--yes` or answer an interactive `y/N`
confirm prompt before any spend happens (`confirm()` refuses to proceed at
all if stdin isn't a TTY and `--yes` wasn't passed — no silent fallback to
"assume yes"). Actual cost afterward is computed by the same formula
applied to *real* token usage (`costUsd()`), so the estimate and the
final receipt can never disagree about the rate, only the token count.

### 2.7 Function-level API surface

| Function | Role |
|---|---|
| `buildSystemPrompt(bookTitle, roster)` | Composes the per-call system prompt, including the roster hint block |
| `updateRoster(roster, characters, chapterIndex)` | Folds one chapter's extracted characters into the running roster (lossy, naming-hint only) |
| `readCheckpointCharacters(outPath)` | Loads just the `characters` array back out of an existing checkpoint file, with a named error on malformed data |
| `costUsd(inputTokens, outputTokens)` | Single source of truth for token→USD, used by both the live estimate and the final receipt |
| `parseArgs(argv)` | CLI flag parsing → `CliOptions` |
| `planChapters(book, opts, chunksDir)` | Classifies every chapter: narrative? cached? should this run extract it? |
| `estimateCostUsd(plans)` | Pre-flight cost projection from the plan, before any call is made |
| `extractChapter(client, book, chapter, roster, outPath)` | The actual API call + checkpoint write for one chapter |
| `processChapters(plans, chunksDir, book, client, roster, manifestChapters, totals)` | Runs the main loop over all chapters, extracting or loading from cache as planned |
| `main()` | CLI entrypoint: wires the above together, handles `--dry-run`/`--rebuild-manifest`, writes the final manifest |

---

## 3. Stage 4 — `merge-thread.ts`: deterministic merge/dedupe

### 3.1 What it actually does, end to end

Load the completed manifest and every chunk file it references, in
chapter order. Replay every chunk's characters through the same
identity-matching logic as stage 3's roster, but instead of collapsing
into a lossy hint, keep **every appearance** as a full history entry.
Run a fixed-point pass to merge any characters that turn out to share an
identifier post-hoc. Detect tier-progression contradictions per character.
Build a canonical name→id lookup from the now-deduped characters, and use
it to resolve every relationship and event's character references across
all chunks. Assemble everything into one `Thread` object and write it out.

No network access, no `ANTHROPIC_API_KEY` dependency, nothing here is
probabilistic — same chunk files in, byte-identical `Thread` shape out,
every time (module the `generatedAt` timestamp).

### 3.2 Loading and validating input — `loadManifest()`, `loadChunks()`

`loadManifest()` refuses to proceed unless `manifest.meta.complete ===
true` — this is the enforcement point for the "never merge a partial
extraction run" rule from §2.5. `loadChunks()` reads chunk files in
chapter-index order and validates each one has a well-formed
`{ characters: [], relationships: [], events: [] }` shape, throwing a
named, actionable error (which file, which chapter, the exact
`--force N` command to fix it) rather than a bare `TypeError` from deep
inside the merge if a chunk is corrupt.

### 3.3 Character identity resolution — the core algorithm

```ts
export function buildCharacters(chunks: ChunkData[]):
  { characters: MergedCharacter[]; nameToId: Map<string, string> }
```

This runs in two phases:

**Phase 1 — greedy replay.** Walk every chunk in chapter order; for each
extracted character, sanitize its name/aliases (`identity.ts`), then try
`findIdentityMatch()` against the characters built *so far*. Match →
append a new `CharacterAppearance` (chapter index, title, name, aliases,
description, role — untruncated, unlike the stage-3 roster) to that
character's `appearances[]`, and unconditionally overwrite the top-level
`description` with this chunk's (recency-first — see §3.4). No match →
mint a new `MergedCharacter` with a fresh, slugified, collision-safe `id`
(`slugifyId()` + `uniqueId()`, e.g. `henry`, and a hypothetical second
distinct "Henry" would become `henry-2`).

**Phase 2 — fixed-point unification.** `unifyCharacters()`:

```ts
export function unifyCharacters(characters: MergedCharacter[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < characters.length; i++) {
      for (let j = i + 1; j < characters.length; ) {
        if (identityOverlaps(characters[j], characters[i])) {
          absorb(characters[i], characters[j]);
          characters.splice(j, 1);
          changed = true;
        } else j++;
      }
    }
  }
}
```

**Why phase 2 is necessary at all**, given phase 1 already does
identity matching: the greedy replay is order-sensitive. A character can
be *created* under a partial name early on ("Lord Brennan" appears
standalone in chapter 11) before a later chunk's aliases reveal that an
earlier, already-existing entity actually answers to that name too. At
that point you have two `MergedCharacter` records whose identifier sets
now overlap, but the greedy single-pass replay already committed them as
separate. Repeatedly scanning all pairs and merging (`absorb()`) until a
full pass makes no changes guarantees the final identifier sets are
**pairwise disjoint** — which matters a lot for §3.5, because the
name→id lookup only works unambiguously if no name could resolve to two
different characters.

`absorb(target, source)` merges `source` into `target`: concatenates and
re-sorts `appearances` by chapter index, unions aliases, promotes to
whichever name is longer, recomputes `description` as the *now-merged*
appearance list's last entry, and widens `firstAppearedChapterIndex` /
`lastAppearedChapterIndex` to the combined range.

After unification, a **finalize pass** re-filters each character's
`aliases` against its *final* name (which may have been promoted to a
longer form partway through either phase) to strip duplicates and
self-references, and runs tier-conflict detection (§3.5) once per
character on the now-complete appearance history.

Only *after* all of this does the code build `nameToId` — deliberately
not incrementally during replay, because a during-replay map would be
last-write-wins and could disagree with the final grouping (e.g. a
character's own later statement resolving to a different id than the one
it actually ended up merged into). Building it once, from final,
disjoint characters, guarantees every name has exactly one possible
owner.

### 3.4 Canonical description: recency-first (the actual bug fix)

Contrast directly with stage 3's roster (§2.3):

| | Stage 3 roster (`updateRoster`) | Stage 4 merge (`buildCharacters`) |
|---|---|---|
| Selection rule | **Longest string wins** | **Most recent chapter wins** (unconditional overwrite) |
| Truncation | Capped at 150 chars | Untruncated |
| History | None — one mutable `description` field | Full `appearances[]`, nothing ever discarded |
| Purpose | Cheap naming hint for the *next* prompt | Authoritative canonical state |

The recency-first rule is a direct, intentional fix for the
longest-string-wins bug — a late chapter's shorter-but-more-current
description ("now runs a shop in the capital") is no longer defeated by an
earlier chapter's longer one ("the baron's studious younger son, trained
in..."). Because full history is preserved regardless, nothing is actually
lost by this choice either way — a consumer that wants "true as of chapter
N" can always recompute it from `appearances` (this is exactly what the
reader-companion demo built earlier in this conversation does).

### 3.5 Progression-order detection — a configurable engine, with tier as its built-in default

```ts
export interface ProgressionOrder { key: string; order: string[]; descriptionPattern: string }
export const DEFAULT_PROGRESSION_ORDERS: ProgressionOrder[]
export function extractProgressionValue(description: string, order: ProgressionOrder): string | null
export function detectProgressionRegressions(appearances: CharacterAppearance[], orders: ProgressionOrder[]): ProgressionRegression[]
export function loadProgressionOrders(configPath?: string | null): ProgressionOrder[]
export function extractTier(description: string): TierName | null
export function detectTierConflicts(appearances: CharacterAppearance[]): TierConflict[]
```

This used to be a single hardcoded path: a module-level `TIER_ORDER =
["Red","Orange","Yellow","Green"]` constant and a regex tuned to exactly
that vocabulary. It's now a **generic, configurable-per-key engine** —
Tier is just that engine's built-in default entry
(`DEFAULT_PROGRESSION_ORDERS[0]`), not a structurally separate case. A
different book's own vocabulary (Level, Class Rank, whatever it uses) is
plugged in via `--progression-order <path>`, a JSON file of `{ key: {
order: string[], descriptionPattern?: string } }` — `loadProgressionOrders()`
merges it over the built-in defaults by key (a config entry can even
override Tier's own order/pattern). **Nothing is ever inferred from book
text** — an earlier design considered auto-inferring a key's order from
the sequence its values first appear in the narrative, but that heuristic
was dropped before implementation: its reasoning conflated first-appearance
order with the mention-*frequency* signal `TIER_ORDER` was actually
hand-derived from, and first-appearance order is a weak signal for this
genre specifically (ensembles routinely introduce already-established
high-rank side characters before the protagonist's own rank climbs that
high). A new key is only ever checked once a human explicitly supplies it.

For each appearance, `extractProgressionValue(description, order)`
regex-matches the **first** value in the description — not the last, not
the highest — because this book's prose convention states current status
before any aspirational target ("Now a Red tier Mystic Potter... hopes to
reach Orange tier someday"); a first-match read is tuned to that specific
convention and would misread a book phrased the other way around. This is
generic across every configured key, not special-cased to tier wording.

`detectProgressionRegressions(appearances, orders)` walks a character's
appearances in chapter order, independently per configured key, and flags
any **adjacent pairwise rank decrease** as a `ProgressionRegression {
key, from: {chapterIndex, value}, to: {chapterIndex, value} }`. These get
surfaced, never silently resolved.

**Tier keeps its own dedicated output bucket for backward compatibility.**
`extractTier()`/`detectTierConflicts()` still exist with their exact
original names, signatures, and return shapes (`TierName | null` and
`TierConflict[]`, no `key` field) — they're now thin wrappers delegating
to the generic engine with `DEFAULT_PROGRESSION_ORDERS[0]`, not deprecated
or removed. `MergedCharacter.conflicts`/`Thread.conflicts`/
`ThreadMeta.conflictCount` remain exclusively Tier's bucket, populated by
that wrapper. Every *other* configured key's regressions land in the new,
purely additive `MergedCharacter.progressionRegressions`/
`Thread.progressionRegressions`/`ThreadMeta.progressionRegressionCount` —
a key is never reported in both places. This split exists because
`TierConflict`'s shape (no `key` field) is baked into already-passing
tests and any future consumer of already-generated thread files; renaming
or reshaping it would be a breaking change for no real benefit.

**Known, explicitly documented limitation, unchanged by this
generalization:** this is still a regex heuristic with **no subject
attribution**, for every configured key, not just Tier. A description
like "recognizing her exceptional Orange tier potential" describing
someone *else* mentioned in the same sentence can be misattributed to the
character this description belongs to. Called out in the source as a
documented limitation, not a bug to patch with ad hoc regex tweaks.

**A separate, still-unsolved limitation: schema-key-name drift.** Nothing
here fuzzy-matches key names — a book configuring both `"Tier"` and
`"Rank"` for what's narratively the same axis gets two independently
tracked (and possibly inconsistent-looking) progression orders. This is a
different problem from the order-generalization above (which values count
as ordered) and would need `identity.ts`-style overlap matching applied to
key names instead of character names — not built.

**The Davos Merrick case from the project's own stage-4 notes** is a good
interview example of *the ceiling of this whole approach*: the book's
prose reveals "she was Green tier just like him" as an indirect
comparison, but every one of the four chunks that mention Davos
independently extracted "Yellow tier" as his stated tier — there is no
cross-chunk *disagreement* for this algorithm to catch, because the
underlying stage-3 extraction never captured the correct value in the
first place. No merge-layer logic operating on chunk JSON alone can
recover a fact that was never written into any chunk. Fixing that class of
error would require a fundamentally different approach — re-reading raw
chapter text with an LLM reconciliation pass — which is a deliberate,
costed, opt-in stage-3.5/4.5 extension that hasn't been built (see §5).

### 3.6 Relationships and events — `buildRelationshipsAndEvents()`

**Name resolution:** `resolveName(raw, chapterIndex, field)` sanitizes a
raw name and looks it up in `nameToId` (case-insensitive). A miss doesn't
throw or drop data silently — it's recorded as a string in a `warnings[]`
array on the final `Thread`, and the caller decides what to do with an
unresolved reference (relationships drop the statement; events keep it
with `id: null`, `name: <original>`).

**Relationships — unordered-pair bucketing:**

```ts
const sorted = [from.id, to.id].sort() as [string, string];
const key = sorted.join("|");
```

Chunks are extracted independently per chapter with no cross-chapter
guidance on direction, so the *same pair* of characters frequently gets
relationship statements in flipped directions across different chapters
(chapter 10: "Henry → Greaves, mentor/neighbor"; chapter 17: "Greaves →
Henry, ..."). Bucketing by the sorted, direction-independent id pair
means these accumulate into **one** evolving `MergedRelationship` instead
of fragmenting into two disconnected records that never learn about each
other. Each individual `RelationshipStatement` still preserves its own
actually-stated `fromId`/`toId` direction inside `history` — nothing about
direction is invented or collapsed, only the *bucketing key* ignores it.
`current` is simply "whichever statement was pushed last," which — because
chunks are processed in ascending chapter order — is equivalent to
"chronologically most recent stated status." (This is the field that,
read directly without an as-of-chapter-N filter, leaks future spoilers —
see the reader-companion discussion earlier in this conversation.)

**Events — no dedup needed.** Each chunk is exactly one chapter's worth of
extraction, chunks are loaded exactly once per manifest entry, and nothing
resolves an event's identity across chapters (`characters_involved` is
resolved to ids, but events themselves are just flattened in chapter
order) — so there's no cross-chunk overlap possible by construction, and
therefore nothing to merge or dedupe at the event level.

### 3.7 Output assembly — `buildThread()`

```ts
export function buildThread(chunksDir: string, slug: string): Thread
```

Orchestrates the whole stage: load → `buildCharacters()` → 
`buildRelationshipsAndEvents()` → flatten each character's `conflicts[]`
into one book-level `conflicts[]` (attaching `characterId`/`characterName`
since the flattened form is consumed independent of the character it came
from) → assemble the `meta` block (counts of everything, generation
timestamp, source manifest path) → return the complete `Thread`.

### 3.8 Function-level API surface

| Function | Role |
|---|---|
| `loadManifest(chunksDir)` | Reads and validates `manifest.json`; refuses incomplete runs |
| `loadChunks(chunksDir, manifest)` | Reads every referenced chunk file, in chapter order, with validated shape |
| `extractProgressionValue(description, order)` | Regex-extracts the first matching value for a given configured key/order |
| `detectProgressionRegressions(appearances, orders)` | Flags rank-decreasing adjacent transitions per configured key |
| `loadProgressionOrders(configPath?)` | Built-in Tier default, optionally merged with a human-supplied `--progression-order` config file |
| `extractTier(description)` | Backward-compatible wrapper: `extractProgressionValue` against the built-in Tier entry |
| `detectTierConflicts(appearances)` | Backward-compatible wrapper: `detectProgressionRegressions` against the built-in Tier entry only |
| `slugifyId(name)` / `uniqueId(base, used)` | Deterministic, collision-safe character id generation |
| `buildCharacters(chunks)` | The full identity-resolution pass (§3.3): replay → unify → finalize → `nameToId` |
| `buildRelationshipsAndEvents(chunks, nameToId, warnings)` | Resolves and buckets relationships; flattens events |
| `buildThread(chunksDir, slug, progressionOrderPath?)` | Top-level orchestration; returns the complete `Thread` |
| `parseArgs(argv)` | CLI flag parsing (`--dry-run`, `--out <path>`, `--progression-order <path>`) |
| `main()` | CLI entrypoint: loads, builds, prints summary, writes `{slug}-thread.json` |

---

## 4. Shared module — `src/identity.ts`

Both stages need one answer to "are these the same character," so it
lives in one place rather than two copies that could drift:

- **`GENERIC_ALIAS`** — a regex rejecting pronouns and possessive-relational
  phrases ("him", "his brother", "our son") as identity keys. These are
  contextual, not identifying — matching on them would chain unrelated
  characters together (anyone's "his brother" would collide with anyone
  else's).
- **`isGenericAlias(alias)`** — additionally rejects lowercase `"the
  ..."` epithets ("the guard", "the merchant") as too generic to be a
  matchable identity key (many different characters answer to a shared
  role/title), while still allowing a distinctive, capitalized epithet
  ("the Mystic Potter", "the Reaper") through.
- **`sanitizeName(raw)`** — strips parenthetical disambiguation the model
  sometimes emits ("Marcus (blacksmith's apprentice)") down to the bare
  name, so it doesn't get echoed back into future prompts/records and
  compound across chapters.
- **`sanitizeAliases(name, rawAliases)`** — applies `sanitizeName` +
  `isGenericAlias` filtering + de-dup + a 40-char length cap to a raw
  alias list.
- **`identifierSet(entity)`** — `{name, ...aliases}` lowercased into a
  `Set<string>`.
- **`identityOverlaps(candidate, known)`** — true if *any* identifier of
  `candidate` matches *any* identifier of `known` — the actual "same
  person" predicate, deliberately permissive (bare-name trust) as
  discussed in §2.3 and §3.3.
- **`findIdentityMatch(candidate, pool)`** — first pool entry overlapping
  `candidate`, or `undefined`. Pure — never mutates `pool`; each caller
  (stage 3's roster, stage 4's replay/unify) decides what "found a match"
  means to do next.

---

## 5. Known limitations worth naming proactively in an interview

- **Bare-name over-merging** is a deliberate, accepted tradeoff (cheap to
  over-merge, expensive to fragment a recurring character), not an
  oversight — but it means two *actually different* characters sharing a
  bare name will incorrectly merge into one `MergedCharacter`, and nothing
  in the current pipeline detects or splits that. It's explicitly flagged
  as unresolved in both `identity.ts` and `merge-thread.ts` comments, and
  as an open question in the stage-4 plan (`plans/stage4-entity-merge-plan.md`).
- **Progression-order detection (Tier included) is a first-match regex
  with no subject attribution** (§3.5) — it can misattribute another
  character's stated value, and it fundamentally cannot catch a value
  that was wrong in every chunk that mentioned it (the real Davos Merrick
  case), because there's no cross-chunk disagreement to detect in that
  scenario. This applies to every configured key, not just the built-in
  Tier default.
- **Schema-key-name drift is unsolved** — a book configuring both `"Tier"`
  and `"Rank"` for the same narrative axis gets two independently tracked
  progression orders; nothing fuzzy-matches key names the way `identity.ts`
  does for character names (§3.5).
- **No LLM-assisted reconciliation exists yet.** The only way to catch
  errors like the Davos case is to re-read raw chapter text with a model,
  which the stage-4 plan explicitly scoped *out* as a deliberate, costed,
  opt-in follow-up — consistent with the project's guardrail against bulk
  API usage without an explicit go-ahead.
- **`relationship.current` and `character.description` are "true as of the
  end of the book," not "true right now"** for any partial reading
  position — a reader-facing consumer has to re-derive an as-of-chapter-N
  view from `appearances`/`history` itself; the thread file does not do
  this for you (covered in depth earlier in this conversation, with a
  concrete demo).
