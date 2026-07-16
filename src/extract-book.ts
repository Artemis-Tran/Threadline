import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  ParsedBook,
  ParsedChapter,
  ExtractedCharacter,
  Extraction,
  deriveSlug,
  RosterEntry,
  SkipReason,
  ManifestChapterEntry,
  CHARACTER_ROLES,
  EVENT_SIGNIFICANCE,
} from "./types";
import { sanitizeName, sanitizeAliases, findIdentityMatch } from "./identity";

interface Totals {
  inputTokens: number;
  outputTokens: number;
  apiCalls: number;
}

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

// Selection heuristic: word count alone misses prose-length non-narrative
// sections (this book's afterword is 419 words), hence the title regex too.
const MIN_NARRATIVE_WORDS = 300;
const NON_NARRATIVE_TITLE =
  /contents|foreword|dedication|afterword|acknowledg|about the author|copyright|epigraph/i;

// A single chapter this long risks truncated output at MAX_TOKENS; splitting
// isn't implemented in stage 3, so refuse rather than produce bad data.
const MAX_CHAPTER_WORDS = 13000;

// Rough cost model for the confirmation gate (Sonnet: $3/$15 per MTok).
const EST_TOKENS_PER_WORD = 2.7;
const EST_PROMPT_OVERHEAD_TOKENS = 1200;
const EST_OUTPUT_TOKENS = 2000;
const INPUT_USD_PER_MTOK = 3;
const OUTPUT_USD_PER_MTOK = 15;

const ROSTER_DESCRIPTION_MAX_CHARS = 150;
const ROSTER_MAX_ALIASES = 8;

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          role: { type: "string", enum: CHARACTER_ROLES },
        },
        required: ["name", "aliases", "description", "role"],
        additionalProperties: false,
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
        },
        required: ["from", "to", "type", "description"],
        additionalProperties: false,
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          characters_involved: { type: "array", items: { type: "string" } },
          significance: { type: "string", enum: EVENT_SIGNIFICANCE },
        },
        required: ["summary", "characters_involved", "significance"],
        additionalProperties: false,
      },
    },
  },
  required: ["characters", "relationships", "events"],
  additionalProperties: false,
} as const;

export function buildSystemPrompt(bookTitle: string | null, roster: RosterEntry[]): string {
  const parts = [
    `You are extracting structured story data from one chapter of the book "${bookTitle ?? "Unknown"}".`,
    "Extract the characters that appear in this chapter, the relationships between them, and the plot events that occur.",
    "Describe only what this chapter itself states or clearly shows. Do not speculate about events outside this chapter, and do not use outside knowledge of the book.",
    "Use the character's most complete name from the chapter as `name`, and list other forms they are called by in `aliases`.",
    "`name` must be a bare name with no parenthetical annotation — never append clarifications in parentheses; put alternate designations in `aliases` and identifying detail in `description`.",
    "In `relationships` and `events`, refer to characters using exactly the same `name` values you used in `characters`.",
    "Judge `role` within this chapter only: \"pov\" is the chapter's viewpoint character, \"major\" is central to this chapter's events, \"supporting\" plays an active but secondary part, \"minor\" appears briefly, \"mentioned\" is named but does not appear.",
    "Judge each event's `significance` to the story: \"major\", \"moderate\", or \"minor\".",
  ];

  if (roster.length > 0) {
    const lines = roster.map((r) => {
      const aliases = r.aliases.length > 0 ? ` | also called: ${r.aliases.join(", ")}` : "";
      return `- name: ${r.name}${aliases} | ${r.description}`;
    });
    parts.push(
      "Characters known so far from previous chapters:\n" + lines.join("\n"),
      "When a character in this chapter is one of these, use exactly the listed `name:` value (only the name itself, never the aliases or description) as `name`."
    );
  }

  return parts.join(" ");
}

// Fold one chapter's characters into the running roster. This is a naming-hint
// index used only to keep the model's later chapters consistent — it is NOT
// authoritative identity resolution. A character is matched to an existing
// entry by any name/alias overlap (including a bare same-name match).
//
// Bare-name identity is trusted deliberately: real characters accumulate many
// non-overlapping aliases across chapters ("Henry Ashford", "Young Master
// Ashford", "the Mystic Potter"), so treating differing aliases as evidence of
// distinct people shreds a recurring character into many entries. The rare
// opposite case — two genuinely different characters sharing a bare name — is
// left for stage 4's dedupe pass, which has the full per-chapter chunk data
// (descriptions, relationships, co-occurring characters) needed to tell them
// apart. Over-merging a hint here is cheap; a fragmented roster is not.
export function updateRoster(roster: RosterEntry[], characters: ExtractedCharacter[], chapterIndex: number): void {
  for (const c of characters) {
    const name = sanitizeName(c.name);
    if (name.length === 0) continue;
    const aliases = sanitizeAliases(name, c.aliases);
    const target = findIdentityMatch({ name, aliases }, roster);

    if (target) {
      for (const alias of [name, ...aliases]) {
        const known = [target.name, ...target.aliases].map((n) => n.toLowerCase());
        if (!known.includes(alias.toLowerCase()) && target.aliases.length < ROSTER_MAX_ALIASES) {
          target.aliases.push(alias);
        }
      }
      // Prefer a fuller description over the terse one often captured at first
      // appearance. Compare the stored (truncated) forms so a genuinely longer
      // description wins; equal-length ties keep the earlier one (no churn).
      const newDescription = c.description.slice(0, ROSTER_DESCRIPTION_MAX_CHARS);
      if (newDescription.length > target.description.length) target.description = newDescription;
      if (chapterIndex > target.lastAppearedChapterIndex) target.lastAppearedChapterIndex = chapterIndex;
    } else {
      roster.push({
        name,
        aliases: aliases.slice(0, ROSTER_MAX_ALIASES),
        description: c.description.slice(0, ROSTER_DESCRIPTION_MAX_CHARS),
        firstAppearedChapterIndex: chapterIndex,
        lastAppearedChapterIndex: chapterIndex,
      });
    }
  }
}

// Load a checkpoint's characters with a clear error if the file is malformed,
// truncated, or from an incompatible schema — rather than a bare TypeError
// deep inside updateRoster that doesn't name the offending file.
export function readCheckpointCharacters(outPath: string): ExtractedCharacter[] {
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  } catch {
    throw new Error(`Checkpoint ${path.basename(outPath)} is not valid JSON — re-extract it with --force ${indexFromCheckpoint(outPath)}.`);
  }
  const characters = (checkpoint as { extraction?: { characters?: unknown } })?.extraction?.characters;
  if (!Array.isArray(characters)) {
    throw new Error(`Checkpoint ${path.basename(outPath)} has no valid extraction.characters array — re-extract it with --force ${indexFromCheckpoint(outPath)}.`);
  }
  return characters as ExtractedCharacter[];
}

export function indexFromCheckpoint(outPath: string): string {
  const match = path.basename(outPath).match(/idx(\d+)-extract\.json/);
  return match ? String(Number(match[1])) : "<index>";
}

// Single source of truth for token → USD, rounded to cents, so the console
// summary and the persisted manifest can never disagree.
export function costUsd(inputTokens: number, outputTokens: number): number {
  return Math.round((inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 1e4) / 100;
}

export interface CliOptions {
  parsedJsonPath: string;
  from: number | null;
  to: number | null;
  skip: Set<number>;
  dryRun: boolean;
  forceAll: boolean;
  forceIndices: Set<number>;
  yes: boolean;
  rebuildManifest: boolean;
}

function parseIndexList(value: string, flag: string): number[] {
  if (!/^\d+(,\d+)*$/.test(value)) {
    throw new Error(`${flag} expects a comma-separated list of indices, got: ${value}`);
  }
  return value.split(",").map(Number);
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    parsedJsonPath: "",
    from: null,
    to: null,
    skip: new Set(),
    dryRun: false,
    forceAll: false,
    forceIndices: new Set(),
    yes: false,
    rebuildManifest: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
      case "--to": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0) throw new Error(`${arg} expects a non-negative integer`);
        if (arg === "--from") opts.from = value;
        else opts.to = value;
        break;
      }
      case "--skip":
        for (const n of parseIndexList(argv[++i] ?? "", "--skip")) opts.skip.add(n);
        break;
      case "--force": {
        const next = argv[i + 1];
        if (next && /^\d+(,\d+)*$/.test(next)) {
          for (const n of parseIndexList(next, "--force")) opts.forceIndices.add(n);
          i++;
        } else {
          opts.forceAll = true;
        }
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--yes":
        opts.yes = true;
        break;
      case "--rebuild-manifest":
        opts.rebuildManifest = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
        if (opts.parsedJsonPath) throw new Error(`Unexpected argument: ${arg}`);
        opts.parsedJsonPath = arg;
    }
  }

  if (!opts.parsedJsonPath) {
    throw new Error(
      "Usage: tsx src/extract-book.ts <parsed-json-path> [--from N] [--to N] [--skip 11,28] [--dry-run] [--force [12,13]] [--yes] [--rebuild-manifest]"
    );
  }
  if (opts.from !== null && opts.to !== null && opts.from > opts.to) {
    throw new Error(`--from (${opts.from}) must not exceed --to (${opts.to}).`);
  }
  return opts;
}

// A chapter is either non-narrative (front/back matter, excluded from the
// thread entirely) or narrative. Narrative chapters always contribute to the
// roster and manifest; the selection flags only decide which of them get a
// (paid) API call this run vs. load from an existing checkpoint.
export interface ChapterPlan {
  chapter: ParsedChapter;
  narrative: boolean;
  skipReason: SkipReason | null;
  hasCheckpoint: boolean;
  willExtract: boolean;
}

export function checkpointPath(chunksDir: string, index: number): string {
  return path.join(chunksDir, `idx${String(index).padStart(3, "0")}-extract.json`);
}

export function planChapters(book: ParsedBook, opts: CliOptions, chunksDir: string): ChapterPlan[] {
  return book.chapters.map((chapter) => {
    let skipReason: SkipReason | null = null;
    if (chapter.wordCount < MIN_NARRATIVE_WORDS) skipReason = "word-count";
    else if (chapter.title && NON_NARRATIVE_TITLE.test(chapter.title)) skipReason = "title";

    const forced = opts.forceIndices.has(chapter.index);
    // An explicitly forced index means "extract this one, period": it overrides
    // the word-count/title heuristics AND the --from/--to window and --skip.
    // Bare --force (forceAll) only bypasses the cache; it must not drag front
    // matter in, nor reach outside the selected window.
    const narrative = skipReason === null || forced;

    const hasCheckpoint = fs.existsSync(checkpointPath(chunksDir, chapter.index));
    const inExtractWindow =
      (opts.from === null || chapter.index >= opts.from) &&
      (opts.to === null || chapter.index <= opts.to) &&
      !opts.skip.has(chapter.index);
    const willExtract =
      narrative && (forced || (inExtractWindow && (opts.forceAll || !hasCheckpoint)));

    return { chapter, narrative, skipReason: narrative ? null : skipReason, hasCheckpoint, willExtract };
  });
}

export function estimateCostUsd(plans: ChapterPlan[]): number {
  const toExtract = plans.filter((p) => p.willExtract);
  const inputTokens = toExtract.reduce(
    (sum, p) => sum + p.chapter.wordCount * EST_TOKENS_PER_WORD + EST_PROMPT_OVERHEAD_TOKENS,
    0
  );
  const outputTokens = toExtract.length * EST_OUTPUT_TOKENS;
  return (inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 1e6;
}

export function planStatus(p: ChapterPlan): string {
  if (!p.narrative) return `skip:${p.skipReason}`;
  if (p.willExtract) return "extract";
  if (p.hasCheckpoint) return "cached";
  return "pending";
}

function printPlan(plans: ChapterPlan[]): void {
  console.log("");
  console.log("idx | words | status     | title");
  console.log("----+-------+------------+------------------------------------------");
  for (const p of plans) {
    const title = (p.chapter.title ?? "").slice(0, 60);
    console.log(
      `${String(p.chapter.index).padStart(3)} | ${String(p.chapter.wordCount).padStart(5)} | ${planStatus(p).padEnd(10)} | ${title}`
    );
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("stdin is not a TTY; pass --yes to run non-interactively.");
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

const MANIFEST_FILE = "manifest.json";
const PARTIAL_MANIFEST_FILE = "manifest.partial.json";

function writeManifest(
  chunksDir: string,
  opts: CliOptions,
  book: ParsedBook,
  manifestChapters: ManifestChapterEntry[],
  roster: RosterEntry[],
  totals: Totals,
  complete: boolean,
  fileName: string = MANIFEST_FILE
): void {
  const manifest = {
    meta: {
      model: MODEL,
      parsedJsonPath: path.resolve(opts.parsedJsonPath),
      bookTitle: book.title,
      timestamp: new Date().toISOString(),
      complete,
      apiCalls: totals.apiCalls,
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      actualCostUsd: costUsd(totals.inputTokens, totals.outputTokens),
      rosterSize: roster.length,
    },
    chapters: manifestChapters,
    roster,
  };
  fs.writeFileSync(path.join(chunksDir, fileName), JSON.stringify(manifest, null, 2), "utf-8");
}

async function extractChapter(
  client: Anthropic,
  book: ParsedBook,
  chapter: ParsedChapter,
  roster: RosterEntry[],
  outPath: string
): Promise<{ extraction: Extraction; usage: Anthropic.Usage }> {
  const systemPrompt = buildSystemPrompt(book.title, roster);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
    messages: [{ role: "user", content: chapter.text }],
  });

  const textBlock = response.content.find((b) => b.type === "text");

  if (response.stop_reason === "refusal") {
    throw new Error(`Chapter ${chapter.index}: model refused (stop_reason: refusal).`);
  }
  if (response.stop_reason === "max_tokens") {
    // Preserve the truncated output for inspection, mirroring the JSON-parse
    // failure path below, so a truncation isn't a silent data loss.
    const rawPath = outPath.replace(/\.json$/, "-truncated.txt");
    fs.writeFileSync(rawPath, textBlock?.text ?? "(no text block)", "utf-8");
    throw new Error(`Chapter ${chapter.index}: output truncated at ${MAX_TOKENS} tokens. Truncated text dumped to: ${rawPath}`);
  }
  if (!textBlock) {
    throw new Error(`Chapter ${chapter.index}: no text block (stop_reason: ${response.stop_reason}).`);
  }

  let extraction: Extraction;
  try {
    extraction = JSON.parse(textBlock.text);
  } catch (err) {
    const rawPath = outPath.replace(/\.json$/, "-raw.txt");
    fs.writeFileSync(rawPath, textBlock.text, "utf-8");
    throw new Error(
      `Chapter ${chapter.index}: response was not valid JSON despite structured outputs (${(err as Error).message}). Raw text dumped to: ${rawPath}`
    );
  }

  const checkpoint = {
    meta: {
      model: response.model,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      chapterWordCount: chapter.wordCount,
      rosterSize: roster.length,
      systemPrompt,
      stopReason: response.stop_reason,
      usage: response.usage,
      timestamp: new Date().toISOString(),
    },
    extraction,
  };
  fs.writeFileSync(outPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  console.log(
    `  characters: ${extraction.characters.length} | relationships: ${extraction.relationships.length} | events: ${extraction.events.length} | tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
  return { extraction, usage: response.usage };
}

// Walk every chapter in book order, building the roster and manifest. Narrative
// chapters that willExtract get a (paid) API call; the rest load from their
// checkpoint so the roster carries full context regardless of the extraction
// window. `client === null` is read-only mode (rebuild): nothing is extracted.
async function processChapters(
  plans: ChapterPlan[],
  chunksDir: string,
  book: ParsedBook,
  client: Anthropic | null,
  roster: RosterEntry[],
  manifestChapters: ManifestChapterEntry[],
  totals: Totals
): Promise<void> {
  for (const plan of plans) {
    const { chapter } = plan;
    const base = { index: chapter.index, title: chapter.title, wordCount: chapter.wordCount };

    if (!plan.narrative) {
      manifestChapters.push({ ...base, status: `skipped:${plan.skipReason!}` });
      continue;
    }

    const outPath = checkpointPath(chunksDir, chapter.index);

    if (client !== null && plan.willExtract) {
      console.log(`[${chapter.index}] extracting (${chapter.wordCount} words, roster ${roster.length}): ${chapter.title ?? ""}`);
      const { extraction, usage } = await extractChapter(client, book, chapter, roster, outPath);
      updateRoster(roster, extraction.characters, chapter.index);
      totals.inputTokens += usage.input_tokens;
      totals.outputTokens += usage.output_tokens;
      totals.apiCalls += 1;
      manifestChapters.push({ ...base, status: "extracted", file: path.basename(outPath) });
    } else if (fs.existsSync(outPath)) {
      updateRoster(roster, readCheckpointCharacters(outPath), chapter.index);
      console.log(`[${chapter.index}] cached: ${chapter.title ?? ""}`);
      manifestChapters.push({ ...base, status: "from-cache", file: path.basename(outPath) });
    } else {
      // Narrative, no checkpoint, and not (re)extracting this run.
      manifestChapters.push({ ...base, status: "pending" });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.parsedJsonPath)) {
    throw new Error(`File not found: ${opts.parsedJsonPath}`);
  }
  const book: ParsedBook = JSON.parse(fs.readFileSync(opts.parsedJsonPath, "utf-8"));

  const slug = deriveSlug(opts.parsedJsonPath);
  const chunksDir = path.resolve(__dirname, "..", "output", `${slug}-chunks`);

  const plans = planChapters(book, opts, chunksDir);
  const toExtract = plans.filter((p) => p.willExtract);
  const cachedCount = plans.filter((p) => p.narrative && !p.willExtract && p.hasCheckpoint).length;
  const pendingCount = plans.filter((p) => p.narrative && !p.willExtract && !p.hasCheckpoint).length;
  const skippedCount = plans.filter((p) => !p.narrative).length;
  const estCost = estimateCostUsd(plans);

  console.log(`Book: ${book.title ?? "(unknown)"} — ${book.chapterCount} flow items, ${book.wordCount} words`);
  printPlan(plans);
  console.log("");
  console.log(
    `${toExtract.length} chapters to extract (${cachedCount} cached, ${pendingCount} pending, ${skippedCount} skipped) — estimated cost ~$${estCost.toFixed(2)} with ${MODEL}`
  );

  // Dry-run wins over every other mode: preview only, never touch disk.
  if (opts.dryRun) {
    console.log("Dry run — no API calls made, manifest not written.");
    return;
  }

  if (opts.rebuildManifest) {
    const missing = plans.filter((p) => p.narrative && !p.hasCheckpoint);
    if (missing.length > 0) {
      throw new Error(
        `--rebuild-manifest requires a checkpoint for every narrative chapter; missing: ${missing.map((p) => p.chapter.index).join(", ")}`
      );
    }
    const roster: RosterEntry[] = [];
    const manifestChapters: ManifestChapterEntry[] = [];
    const totals: Totals = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
    await processChapters(plans, chunksDir, book, null, roster, manifestChapters, totals);
    writeManifest(chunksDir, opts, book, manifestChapters, roster, totals, true);
    console.log(`Manifest rebuilt from ${manifestChapters.filter((c) => c.status === "from-cache").length} cached chunks — no API calls made.`);
    return;
  }

  const oversized = toExtract.filter((p) => p.chapter.wordCount > MAX_CHAPTER_WORDS);
  if (oversized.length > 0) {
    throw new Error(
      `Chapters ${oversized.map((p) => p.chapter.index).join(", ")} exceed ${MAX_CHAPTER_WORDS} words; chapter splitting is not implemented. Aborting.`
    );
  }

  if (toExtract.length === 0 && cachedCount === 0) {
    console.log("Nothing to extract or load. Check --from/--to/--skip.");
    return;
  }
  if (toExtract.length > 0 && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env before running extraction.");
  }
  if (toExtract.length > 0 && !opts.yes) {
    if (!(await confirm(`Proceed with ${toExtract.length} API calls (~$${estCost.toFixed(2)})? [y/N] `))) {
      console.log("Aborted before any API call.");
      return;
    }
  }

  fs.mkdirSync(chunksDir, { recursive: true });
  // Only need a client when there's something to extract; an all-cached run
  // just rebuilds the roster/manifest from disk.
  const client = toExtract.length > 0 ? new Anthropic() : null;

  // Accumulators owned here so a mid-run failure still has the partial state
  // (real token totals, chapters completed so far) to persist.
  const roster: RosterEntry[] = [];
  const manifestChapters: ManifestChapterEntry[] = [];
  const totals: Totals = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
  const manifestPath = path.join(chunksDir, MANIFEST_FILE);
  const partialPath = path.join(chunksDir, PARTIAL_MANIFEST_FILE);

  try {
    await processChapters(plans, chunksDir, book, client, roster, manifestChapters, totals);
  } catch (err) {
    // Persist progress to a side file rather than clobbering a possibly-complete
    // manifest.json with a truncated one; a rerun resumes from the checkpoints.
    writeManifest(chunksDir, opts, book, manifestChapters, roster, totals, false, PARTIAL_MANIFEST_FILE);
    console.error(`Partial (incomplete) manifest written to ${partialPath} before failure; ${manifestPath} left intact.`);
    throw err;
  }

  writeManifest(chunksDir, opts, book, manifestChapters, roster, totals, true);
  // A prior partial run's leftover is now superseded by this complete manifest.
  if (fs.existsSync(partialPath)) fs.rmSync(partialPath);

  console.log("");
  console.log("Run summary");
  console.log("-----------");
  console.log(`API calls:       ${totals.apiCalls}`);
  console.log(`Tokens:          ${totals.inputTokens} in / ${totals.outputTokens} out`);
  console.log(`Actual cost:     ~$${costUsd(totals.inputTokens, totals.outputTokens).toFixed(2)}`);
  console.log(`Roster size:     ${roster.length} characters`);
  console.log(`Chunks dir:      ${chunksDir}`);
  console.log(`Manifest:        ${manifestPath}`);
}

// Only run the CLI when executed directly — the planning/roster helpers above
// are also imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    if (err instanceof Anthropic.APIError) {
      console.error(`API error ${err.status}: ${err.message}`);
    } else {
      console.error(`Extraction failed: ${err instanceof Error ? err.message : err}`);
    }
    console.error("Any checkpoints already written are preserved; rerun to resume.");
    process.exitCode = 1;
  });
}
