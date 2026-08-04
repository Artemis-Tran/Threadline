import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { performance } from "perf_hooks";
import {
  ParsedBook,
  ParsedChapter,
  ExtractedCharacter,
  Extraction,
  deriveSlug,
  RosterEntry,
  SkipReason,
  ManifestChapterEntry,
  CHARACTER_KINDS,
  CHARACTER_ROLES,
  EVENT_SIGNIFICANCE,
} from "./types";
import { sanitizeName, sanitizeAliases, findIdentityMatch } from "./identity";
import { DEFAULT_MODEL, resolveModel, ModelInfo, ModelRates } from "./models";
import {
  callExtraction,
  apiErrorMessage,
  apiKeyEnvVar,
  reasoningEffort,
  ExtractionClient,
  ExtractionUsage,
} from "./extraction-call";

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  apiCalls: number;
}

const MAX_TOKENS = 16000;

// Selection heuristic: word count alone misses prose-length non-narrative
// sections (this book's afterword is 419 words), hence the title regex too.
const MIN_NARRATIVE_WORDS = 300;
const NON_NARRATIVE_TITLE =
  /contents|foreword|dedication|afterword|acknowledg|about the author|copyright|epigraph/i;

// A single chapter this long risks truncated output at MAX_TOKENS; splitting
// isn't implemented in the extract step, so refuse rather than produce bad data.
const MAX_CHAPTER_WORDS = 13000;

// Rough token model for the confirmation gate; per-model $/MTok rates and the
// per-chapter output estimate come from the resolved model (see ./models).
const EST_TOKENS_PER_WORD = 2.7;
const EST_PROMPT_OVERHEAD_TOKENS = 1200;

const ROSTER_DESCRIPTION_MAX_CHARS = 150;
const ROSTER_MAX_ALIASES = 8;

// Deliberately not `as const`: the seam takes a plain JSON-schema object, and a
// deeply-readonly literal would only have to be cast back into one at the call.
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
          kind: { type: "string", enum: CHARACTER_KINDS },
        },
        // `kind` is REQUIRED here while being optional on ExtractedCharacter.
        // The two are not in tension: optional is a read rule for extracts
        // written before the tag existed, whereas OpenAI's strict structured
        // outputs (extraction-call.ts) rejects any schema whose `properties`
        // and `required` disagree — so leaving it out here would fail every
        // OpenAI run at the API. Requiring it also forces the model to make
        // the individual/collective call explicitly on every entry.
        required: ["name", "aliases", "description", "role", "kind"],
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
};

export function buildSystemPrompt(bookTitle: string | null, roster: RosterEntry[]): string {
  const parts = [
    `You are extracting structured story data from one chapter of the book "${bookTitle ?? "Unknown"}".`,
    "Extract the characters that appear in this chapter, the relationships between them, and the plot events that occur.",
    "A character is an entity the story treats as an actor — something that acts, chooses, or speaks of its own accord — and refers to by a stable designator. It does not have to be a person: a god, a beast, a ship, or a system counts if the story gives it agency. Something that is only made, sold, carried, displayed, or used is not a character, however important or magical it is.",
    "A stable designator is one the entity carries outside this scene: a name, or a standing post the story treats as ongoing, such as \"Elise's governess\". A role filled for the length of one errand is not a standing post — the runner who carried one message, the driver of one carriage, the clerk who stamped one form. Apply this test before creating an entry — could a later chapter refer to this entity by this designator? If the designator identifies the entity only by what it did or where it stood here — \"the elderly basket weaver\", \"the merchant who bought a lamp\", \"the first customer\" — it fails the test, and you must not create an entry for that entity. A named character who appears in only one scene passes the test and is still a character.",
    "Describe only what this chapter itself states or clearly shows. Do not speculate about events outside this chapter, and do not use outside knowledge of the book.",
    "Use the character's most complete name from the chapter as `name`, and list other forms they are called by in `aliases`.",
    "`name` must be a bare name with no parenthetical annotation — never append clarifications in parentheses; put alternate designations in `aliases` and identifying detail in `description`.",
    "In `relationships` and `events`, refer to characters using exactly the same `name` values you used in `characters`.",
    "Judge `role` within this chapter only: \"pov\" is the chapter's viewpoint character, \"major\" is central to this chapter's events, \"supporting\" plays an active but secondary part, \"minor\" appears briefly, \"mentioned\" is named but does not appear.",
    "Judge each event's `significance` to the story: \"major\", \"moderate\", or \"minor\".",
    "Set `kind` to \"collective\" when an entry stands for more than one entity — a body, crew, household, order, or crowd acting together, such as a guild council or the dock workers. Set it to \"individual\" for a single entity, including a non-human one.",
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
// left for the merge step's dedupe pass, which has the full per-chapter data
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

// Read a roster supplied with --roster, so a run can start from a roster it did
// not accumulate. This exists for the single-chapter probe: without it, asking
// "does this extraction model reuse a roster entry's name verbatim?" means
// paying for the chapters that would build one.
//
// Entries are used verbatim — none of updateRoster's normalization (parenthetical
// stripping, generic-alias filtering, the alias cap, the description truncation)
// is applied. The flag's whole purpose is handing the model a deliberately
// adversarial roster, and silently rewriting the operator's file would defeat
// that. A roster copied out of a manifest is already normalized, so the
// prompt-identity property that matters holds regardless.
//
// Every failure here throws before the caller reaches an API call, so a bad
// file costs nothing.
export function readRosterFile(rosterPath: string): RosterEntry[] {
  const resolved = path.resolve(rosterPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`--roster file not found: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch (err) {
    throw new Error(`--roster file is not valid JSON (${(err as Error).message}): ${resolved}`);
  }

  if (!Array.isArray(parsed)) {
    // A manifest is the obvious near-miss — it's where an operator gets a real
    // roster from — so name the fix rather than just the rejection.
    const hint =
      isObject(parsed) && Array.isArray((parsed as { roster?: unknown }).roster)
        ? " — this looks like a manifest; pass its `roster` array instead"
        : "";
    throw new Error(`--roster file must contain a JSON array of roster entries${hint}: ${resolved}`);
  }

  parsed.forEach((entry, i) => assertRosterEntry(entry, i, resolved));
  return parsed as RosterEntry[];
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Requires the full RosterEntry shape rather than just the three fields the
// prompt reads: a supplied entry is folded into the running roster by
// updateRoster and written to the manifest, both of which use the chapter
// indices. Accepting a partial entry would put `undefined` in a manifest.
function assertRosterEntry(entry: unknown, i: number, rosterPath: string): void {
  const bad = (problem: string): never => {
    throw new Error(`--roster entry ${i} ${problem} (in ${rosterPath})`);
  };

  if (!isObject(entry)) bad("is not an object");
  const e = entry as Record<string, unknown>;

  if (typeof e.name !== "string" || e.name.trim().length === 0) {
    bad("needs a non-empty string `name`");
  }
  if (!Array.isArray(e.aliases) || e.aliases.some((a) => typeof a !== "string")) {
    bad("needs an `aliases` array of strings");
  }
  if (typeof e.description !== "string") {
    bad("needs a string `description`");
  }
  for (const key of ["firstAppearedChapterIndex", "lastAppearedChapterIndex"] as const) {
    const value = e[key];
    if (!Number.isInteger(value) || (value as number) < 0) {
      bad(`needs a non-negative integer \`${key}\``);
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

// The registry ID a checkpoint's extraction was requested with (from its meta
// `model`, never its `modelReturned`). Null when the file is unreadable or
// predates model stamping — callers treat null as "can't verify" rather than a
// mismatch, so legacy checkpoints aren't force-invalidated.
export function readCheckpointModel(outPath: string): string | null {
  try {
    const meta = (JSON.parse(fs.readFileSync(outPath, "utf-8")) as { meta?: { model?: unknown } }).meta;
    return typeof meta?.model === "string" ? meta.model : null;
  } catch {
    return null;
  }
}

// Guard against silently mixing models in one chunks dir. A cached checkpoint is
// loaded verbatim into the roster and never re-extracted, so pointing --model X
// at a dir whose checkpoints were written by model Y would blend the two — and
// writeManifest would then stamp X over the whole run. Only checkpoints that
// will be LOADED from cache are checked; chapters being re-extracted overwrite
// theirs. Runs before any API call, so a mismatch costs nothing.
export function assertCheckpointModelsMatch(
  plans: ChapterPlan[],
  chunksDir: string,
  model: string,
  rebuildMode = false
): void {
  const conflicts: string[] = [];
  for (const p of plans) {
    if (!p.narrative || !p.hasCheckpoint) continue;
    // In a normal run, willExtract chapters are re-extracted (overwriting their
    // checkpoint), so their recorded model is irrelevant. In --rebuild-manifest
    // mode nothing is extracted — even a forced index is loaded from cache — so
    // every cached checkpoint must match the model the manifest will claim.
    if (!rebuildMode && p.willExtract) continue;
    const found = readCheckpointModel(checkpointPath(chunksDir, p.chapter.index));
    if (found !== null && found !== model) conflicts.push(`idx ${p.chapter.index} (${found})`);
  }
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? `, … (+${conflicts.length - 5} more)` : "");
    throw new Error(
      `Model mismatch: --model ${model} would reuse ${conflicts.length} checkpoint(s) from a different model — ${shown}. ` +
        `Use --out-dir to write this model's run to a separate directory, or --force to re-extract those chapters.`
    );
  }
}

// Single source of truth for token → USD, rounded to cents, so the console
// summary and the persisted manifest can never disagree.
export function costUsd(inputTokens: number, outputTokens: number, rates: ModelRates): number {
  return Math.round((inputTokens * rates.inputUsdPerMTok + outputTokens * rates.outputUsdPerMTok) / 1e4) / 100;
}

export interface CliOptions {
  parsedJsonPath: string;
  // Print the chapter index ↔ title mapping and stop. Makes no API call and
  // reads nothing but the parsed book, so finding an index costs nothing.
  list: boolean;
  from: number | null;
  to: number | null;
  skip: Set<number>;
  dryRun: boolean;
  forceAll: boolean;
  forceIndices: Set<number>;
  yes: boolean;
  rebuildManifest: boolean;
  // Resolved model ID (see ./models). Defaults to DEFAULT_MODEL when --model is
  // omitted, so a no-flag run is unchanged.
  model: string;
  // Override for the chunks output dir. Null = the default output/{slug}-chunks.
  // Lets an A/B run write elsewhere without clobbering the baseline's chunks.
  outDir: string | null;
  // Path to a JSON array of roster entries to start the run with. Null = the
  // roster is built only by replaying earlier chapters, as it always was.
  rosterPath: string | null;
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
    list: false,
    from: null,
    to: null,
    skip: new Set(),
    dryRun: false,
    forceAll: false,
    forceIndices: new Set(),
    yes: false,
    rebuildManifest: false,
    model: DEFAULT_MODEL,
    outDir: null,
    rosterPath: null,
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
      case "--list":
        opts.list = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--yes":
        opts.yes = true;
        break;
      case "--rebuild-manifest":
        opts.rebuildManifest = true;
        break;
      case "--model": {
        const value = argv[++i];
        if (!value) throw new Error("--model expects a model name");
        opts.model = resolveModel(value).id;
        break;
      }
      case "--out-dir": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) throw new Error("--out-dir expects a path");
        opts.outDir = value;
        break;
      }
      case "--roster": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) throw new Error("--roster expects a path");
        opts.rosterPath = value;
        break;
      }
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
        if (opts.parsedJsonPath) throw new Error(`Unexpected argument: ${arg}`);
        opts.parsedJsonPath = arg;
    }
  }

  if (!opts.parsedJsonPath) {
    throw new Error(
      "Usage: tsx src/extract-book.ts <parsed-json-path> [--list] [--from N] [--to N] [--skip 11,28] [--dry-run] [--force [12,13]] [--yes] [--rebuild-manifest] [--model <id>] [--out-dir <path>] [--roster <path>]"
    );
  }
  if (opts.from !== null && opts.to !== null && opts.from > opts.to) {
    throw new Error(`--from (${opts.from}) must not exceed --to (${opts.to}).`);
  }
  // A rebuild makes no API calls and exists to reproduce a manifest from the
  // chapter extracts on disk — so its roster must stay purely derived from them.
  // Seeding it would persist operator-supplied entries into the manifest that
  // ADR-0006 makes later steps trust, with nothing on disk to back them.
  if (opts.rosterPath !== null && opts.rebuildManifest) {
    throw new Error("--roster cannot be combined with --rebuild-manifest: a rebuilt manifest's roster must come only from the chapter extracts on disk.");
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

// The chapter index ↔ title mapping, one line per flow item. The array index is
// NOT the book's chapter number — front matter and POV interludes are
// interleaved — so picking an index for --from/--to/--force means looking here
// first. Falls back to the chapter's opening line for an untitled item.
export function chapterIndexLines(book: ParsedBook): string[] {
  return book.chapters.map((c) => {
    const title = c.title ?? c.text.split("\n")[0].slice(0, 80);
    return `${String(c.index).padStart(3)} | ${String(c.wordCount).padStart(5)} words | ${title}`;
  });
}

// A forced index means "extract this one, period", so one the book does not
// have is an operator error rather than an empty selection. Without this it
// falls through to "Nothing to extract or load. Check --from/--to/--skip",
// which names flags the operator may never have typed — the single-chapter
// probe forwards --force, so that is exactly what its user would see after
// mistyping a chapter index.
//
// Only the upper bound is checked: both argument parsers accept digits only,
// so a negative index cannot reach here.
export function assertForceIndicesInRange(forceIndices: Set<number>, chapterCount: number): void {
  const outOfRange = [...forceIndices].filter((i) => i >= chapterCount).sort((a, b) => a - b);
  if (outOfRange.length > 0) {
    throw new Error(
      `No such chapter: ${outOfRange.join(", ")}. This book's indices run [0, ${chapterCount - 1}] — run with --list to see them.`
    );
  }
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

export function estimateCostUsd(plans: ChapterPlan[], model: ModelInfo): number {
  const toExtract = plans.filter((p) => p.willExtract);
  const inputTokens = toExtract.reduce(
    (sum, p) => sum + p.chapter.wordCount * EST_TOKENS_PER_WORD + EST_PROMPT_OVERHEAD_TOKENS,
    0
  );
  const outputTokens = toExtract.length * model.outputTokenEstimate;
  return (inputTokens * model.rates.inputUsdPerMTok + outputTokens * model.rates.outputUsdPerMTok) / 1e6;
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
  const model = resolveModel(opts.model);
  const rates = model.rates;
  const effort = reasoningEffort(model.provider);
  const manifest = {
    meta: {
      model: opts.model,
      // Beside the model for the same reason the chapter extracts carry it:
      // this is the file a comparison tool reads to say what produced a run.
      ...(effort === null ? {} : { reasoningEffort: effort }),
      parsedJsonPath: path.resolve(opts.parsedJsonPath),
      bookTitle: book.title,
      timestamp: new Date().toISOString(),
      complete,
      apiCalls: totals.apiCalls,
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      actualCostUsd: costUsd(totals.inputTokens, totals.outputTokens, rates),
      rosterSize: roster.length,
      ...(opts.rosterPath === null ? {} : { rosterPath: path.resolve(opts.rosterPath) }),
    },
    chapters: manifestChapters,
    roster,
  };
  fs.writeFileSync(path.join(chunksDir, fileName), JSON.stringify(manifest, null, 2), "utf-8");
}

// The seam reports refusal, truncation and unusable output as ordinary results;
// this command throws on all three. That mapping is the sharpest edge in going
// through the seam — get it wrong and a truncated-but-paid-for response is
// discarded as though it were something else, or a non-answer is written out as
// an extraction — so only a stop reason of "ok" proceeds.
export async function extractChapter(
  client: ExtractionClient | undefined,
  book: ParsedBook,
  chapter: ParsedChapter,
  roster: RosterEntry[],
  outPath: string,
  model: ModelInfo
): Promise<{ extraction: Extraction; usage: ExtractionUsage }> {
  const systemPrompt = buildSystemPrompt(book.title, roster);

  const response = await callExtraction(
    {
      model: model.id,
      provider: model.provider,
      systemPrompt,
      chapterText: chapter.text,
      schema: EXTRACTION_SCHEMA,
      maxTokens: MAX_TOKENS,
    },
    client
  );

  if (response.stopReason === "refusal") {
    throw new Error(`Chapter ${chapter.index}: model refused (stop reason: refusal).`);
  }
  if (response.stopReason === "max_tokens") {
    // Preserve the truncated output for inspection, mirroring the JSON-parse
    // failure path below, so a truncation isn't a silent data loss.
    const rawPath = outPath.replace(/\.json$/, "-truncated.txt");
    fs.writeFileSync(rawPath, response.text === "" ? "(no text)" : response.text, "utf-8");
    throw new Error(`Chapter ${chapter.index}: output truncated at ${MAX_TOKENS} tokens. Truncated text dumped to: ${rawPath}`);
  }
  // Anything that is not "ok" is unusable, whether or not text came back with
  // it. Text is not evidence the answer is complete: an OpenAI response with
  // status "failed" can carry a partial message, and parsing that would write a
  // half-answer to disk as though it were a genuine extract. This deliberately
  // reads the stop reason rather than only the text — the seam defines "other"
  // as output a caller can do nothing with, and taking it at its word is what
  // keeps a non-extraction out of the thread.
  if (response.stopReason !== "ok" || response.text === "") {
    throw new Error(`Chapter ${chapter.index}: no usable text (stop reason: ${response.stopReason}).`);
  }

  let extraction: Extraction;
  try {
    extraction = JSON.parse(response.text);
  } catch (err) {
    const rawPath = outPath.replace(/\.json$/, "-raw.txt");
    fs.writeFileSync(rawPath, response.text, "utf-8");
    throw new Error(
      `Chapter ${chapter.index}: response was not valid JSON despite structured outputs (${(err as Error).message}). Raw text dumped to: ${rawPath}`
    );
  }

  const effort = reasoningEffort(model.provider);

  const checkpoint = {
    meta: {
      // The registry ID that was *requested*, not the string the vendor
      // returned (ADR-0008). The requested ID is the one the registry can price
      // and the one a resume can match; a served string survives neither, since
      // a vendor resolving an alias to a dated snapshot records an ID the
      // registry has never heard of. The served string is kept alongside so a
      // silently re-pointed alias stays visible.
      model: model.id,
      modelReturned: response.modelReturned,
      // Which effort the seam is pinned to for this provider, absent on a
      // vendor that has no such concept. The model alone does not identify a
      // run: the same book at two efforts produces two different sets of
      // extracts, and without this they are indistinguishable on disk.
      ...(effort === null ? {} : { reasoningEffort: effort }),
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      chapterWordCount: chapter.wordCount,
      rosterSize: roster.length,
      systemPrompt,
      // The seam's normalised reason rather than the vendor's own word for it,
      // so this field means the same thing whichever vendor served the chapter.
      stopReason: response.stopReason,
      // Snake_case because that is what these keys have always been called on
      // disk and what compare-extractions reads to price a run — but the counts
      // are now the seam's normalised ones, so the vendor's extra fields
      // (cache reads, service tier) no longer appear. They were never read.
      // The reasoning split decomposes the output count rather than adding to
      // it, so the billed totals are untouched by its presence.
      usage: {
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        ...(response.usage.reasoningTokens === undefined
          ? {}
          : { reasoning_tokens: response.usage.reasoningTokens }),
      },
      timestamp: new Date().toISOString(),
    },
    extraction,
  };
  fs.writeFileSync(outPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  // The caller (processChapters) owns per-chapter logging so it can render a
  // single line carrying the progress ordinal, counts, tokens, and timing.
  return { extraction, usage: response.usage };
}

// "4.2s" for short spans, "1m 05s" once past a minute — used for both the
// per-chapter elapsed time and the final run duration. Rounds to whole seconds
// *before* splitting minutes/seconds so a value like 119.6s renders "2m 00s",
// never "1m 60s".
function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (Math.round(totalSec) < 60) return `${totalSec.toFixed(1)}s`;
  const whole = Math.round(totalSec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export interface ChapterRunInput {
  plans: ChapterPlan[];
  chunksDir: string;
  book: ParsedBook;
  // Resolved rather than a bare ID: the walk needs the registry row's provider
  // to reach the right vendor, and the row is the authority on that (see
  // ./models). The ID it carries is also what a chapter extract is stamped with.
  model: ModelInfo;
  // Mutated in place — the caller owns these, for the reason given where main()
  // declares them.
  roster: RosterEntry[];
  manifestChapters: ManifestChapterEntry[];
  totals: Totals;
  // Denominator for the progress ordinal only — the plans decide what is
  // actually extracted.
  toExtractCount: number;
  // --rebuild-manifest: replay the chapter extracts already on disk and make no
  // API call, not even for an index --force targeted. Named as the flag is, and
  // as assertCheckpointModelsMatch already names the same condition.
  //
  // It is a separate field from `client` deliberately. A null client used to
  // mean this, while the extraction seam's optional client means "a test
  // double, otherwise a real one" — one parameter holding both a mode and a
  // dependency, with null and undefined meaning opposite things.
  rebuildMode?: boolean;
  // Omitted on a live run, which lets the seam construct a real SDK client for
  // the model's provider; supplied by tests. Note which way this defaults: an
  // extraction with no client is the paying path, not an inert one.
  client?: ExtractionClient;
}

// Walk every chapter in book order, building the roster and manifest. Narrative
// chapters that willExtract get a (paid) API call; the rest load from their
// checkpoint so the roster carries full context regardless of the extraction
// window.
export async function processChapters(input: ChapterRunInput): Promise<void> {
  const { plans, chunksDir, book, roster, manifestChapters, totals, toExtractCount, model, rebuildMode } =
    input;
  let extractedSoFar = 0;
  // Forwarded to the seam as-is. Undefined means "construct a real client for
  // this model's provider", which the seam does per call — so a caller that
  // supplies none, as every test does, never constructs an SDK client at all.
  // main() still refuses to start without a credential.
  const client = input.client;

  for (const plan of plans) {
    const { chapter } = plan;
    const base = { index: chapter.index, title: chapter.title, wordCount: chapter.wordCount };

    if (!plan.narrative) {
      manifestChapters.push({ ...base, status: `skipped:${plan.skipReason!}` });
      continue;
    }

    const outPath = checkpointPath(chunksDir, chapter.index);

    if (!rebuildMode && plan.willExtract) {
      const ordinal = `[${++extractedSoFar}/${toExtractCount}]`;
      const label = `${ordinal} idx ${chapter.index} · ${chapter.title ?? ""}`;
      // Print the prefix without a newline so the in-flight chapter is visible
      // during the (multi-second) API call, then complete the same physical line
      // with the results once it returns — one line per chapter, but still live.
      process.stdout.write(`${label} — extracting (${chapter.wordCount} words, roster ${roster.length})… `);
      const startedAt = performance.now();
      let extraction: Extraction;
      let usage: ExtractionUsage;
      try {
        ({ extraction, usage } = await extractChapter(client, book, chapter, roster, outPath, model));
      } catch (err) {
        // The prefix above has no newline; terminate the dangling line so the
        // failure message that follows isn't glued onto it.
        process.stdout.write("\n");
        throw err;
      }
      updateRoster(roster, extraction.characters, chapter.index);
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.apiCalls += 1;
      manifestChapters.push({ ...base, status: "extracted", file: path.basename(outPath) });
      // The reasoning split is shown only when the vendor reported one, so a
      // blank stays honest about a model that said nothing.
      const reasoningNote =
        usage.reasoningTokens === undefined ? "" : ` (${usage.reasoningTokens} reasoning)`;
      console.log(
        `done · ${extraction.characters.length} chars, ${extraction.relationships.length} rels, ${extraction.events.length} events · ${usage.inputTokens}/${usage.outputTokens}${reasoningNote} tok · ${formatDuration(performance.now() - startedAt)}`
      );
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

  // Ahead of everything else, including the roster file: a listing exists to
  // find a chapter index, so it must not be gated on flags that only matter
  // once one has been chosen, and it must stay free.
  if (opts.list) {
    for (const line of chapterIndexLines(book)) console.log(line);
    return;
  }

  assertForceIndicesInRange(opts.forceIndices, book.chapters.length);

  // Validated up front — before the plan, the cost gate, and any API call — so
  // a malformed roster file costs nothing and fails where the message is still
  // about the file rather than about a run that already started.
  const suppliedRoster = opts.rosterPath === null ? [] : readRosterFile(opts.rosterPath);

  const slug = deriveSlug(opts.parsedJsonPath);
  const chunksDir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.resolve(__dirname, "..", "output", `${slug}-chunks`);

  const plans = planChapters(book, opts, chunksDir);
  // Fail fast (before any API call) if this model would reuse another model's
  // cached checkpoints from this dir. In --rebuild-manifest mode every cached
  // checkpoint is loaded (even forced indices), so check them all.
  assertCheckpointModelsMatch(plans, chunksDir, opts.model, opts.rebuildManifest);
  const toExtract = plans.filter((p) => p.willExtract);
  const cachedCount = plans.filter((p) => p.narrative && !p.willExtract && p.hasCheckpoint).length;
  const pendingCount = plans.filter((p) => p.narrative && !p.willExtract && !p.hasCheckpoint).length;
  const skippedCount = plans.filter((p) => !p.narrative).length;
  const model = resolveModel(opts.model);
  const estCost = estimateCostUsd(plans, model);

  console.log(`Book: ${book.title ?? "(unknown)"} — ${book.chapterCount} flow items, ${book.wordCount} words`);
  printPlan(plans);
  console.log("");
  console.log(
    `${toExtract.length} chapters to extract (${cachedCount} cached, ${pendingCount} pending, ${skippedCount} skipped) — estimated cost ~$${estCost.toFixed(2)} with ${opts.model}`
  );
  // The roster is normally invisible input; when it was supplied rather than
  // accumulated, say so — it changes every prompt this run sends.
  if (opts.rosterPath !== null) {
    const n = suppliedRoster.length;
    console.log(`Roster seeded with ${n} ${n === 1 ? "entry" : "entries"} from ${opts.rosterPath}`);
  }

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
    // Not seeded from --roster: parseArgs rejects that combination.
    const roster: RosterEntry[] = [];
    const manifestChapters: ManifestChapterEntry[] = [];
    const totals: Totals = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
    await processChapters({
      plans,
      chunksDir,
      book,
      model,
      roster,
      manifestChapters,
      totals,
      toExtractCount: 0,
      rebuildMode: true,
    });
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
  // Provider-derived, so an OpenAI run never demands an Anthropic key or the
  // reverse, and the message names the one variable that is actually missing.
  if (toExtract.length > 0) {
    const envVar = apiKeyEnvVar(model.provider);
    if (!process.env[envVar]) {
      throw new Error(`${envVar} is not set. Add it to .env before running extraction.`);
    }
  }
  if (toExtract.length > 0 && !opts.yes) {
    if (!(await confirm(`Proceed with ${toExtract.length} API calls (~$${estCost.toFixed(2)})? [y/N] `))) {
      console.log("Aborted before any API call.");
      return;
    }
  }

  fs.mkdirSync(chunksDir, { recursive: true });

  // Accumulators owned here so a mid-run failure still has the partial state
  // (real token totals, chapters completed so far) to persist. A supplied roster
  // seeds the accumulator; each chapter then folds into it exactly as it would
  // have folded into an accumulated one.
  const roster: RosterEntry[] = [...suppliedRoster];
  const manifestChapters: ManifestChapterEntry[] = [];
  const totals: Totals = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
  const manifestPath = path.join(chunksDir, MANIFEST_FILE);
  const partialPath = path.join(chunksDir, PARTIAL_MANIFEST_FILE);

  const runStart = performance.now();
  try {
    await processChapters({
      plans,
      chunksDir,
      book,
      model,
      roster,
      manifestChapters,
      totals,
      toExtractCount: toExtract.length,
    });
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
  console.log(`✓ Done — ${totals.apiCalls}/${toExtract.length} chapters extracted in ${formatDuration(performance.now() - runStart)}`);
  console.log("");
  console.log("Run summary");
  console.log("-----------");
  console.log(`API calls:       ${totals.apiCalls}`);
  console.log(`Tokens:          ${totals.inputTokens} in / ${totals.outputTokens} out`);
  console.log(`Actual cost:     ~$${costUsd(totals.inputTokens, totals.outputTokens, model.rates).toFixed(2)}`);
  console.log(`Roster size:     ${roster.length} characters`);
  console.log(`Chunks dir:      ${chunksDir}`);
  console.log(`Manifest:        ${manifestPath}`);
}

// Only run the CLI when executed directly — the planning/roster helpers above
// are also imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    // Asked of the seam rather than tested against an SDK error class, so this
    // handler does not have to import either vendor to tell an API failure from
    // a bug — and names which vendor failed now that there are two.
    const apiMessage = apiErrorMessage(err);
    if (apiMessage !== null) {
      console.error(apiMessage);
    } else {
      console.error(`Extraction failed: ${err instanceof Error ? err.message : err}`);
    }
    console.error("Any checkpoints already written are preserved; rerun to resume.");
    process.exitCode = 1;
  });
}
