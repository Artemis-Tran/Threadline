import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
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
  CHARACTER_ROLES,
  EVENT_SIGNIFICANCE,
} from "./types";
import { sanitizeName, sanitizeAliases, findIdentityMatch } from "./identity";
import { DEFAULT_MODEL, resolveModel, ModelInfo, ModelRates } from "./models";
import { anthropicReasoningTokens } from "./extraction-call";

// The slice of an Anthropic client stage 3 uses, declared structurally for the
// reason given on AnthropicExtractionClient in ./extraction-call — a test can
// inject a canned response without standing up a real client. It is a separate
// declaration because stage 3 reads the vendor's full usage object, which the
// seam's narrower response type does not carry.
//
// This is not stage 3 going through the seam: it still builds its own request
// and reads its own vendor response (ADR-0008). It is only what makes the
// extract writer testable offline.
export interface BookExtractionClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<BookExtractionResponse>;
  };
}

interface BookExtractionResponse {
  model: string;
  stop_reason: string | null;
  content: Anthropic.Message["content"];
  usage: Anthropic.Message["usage"];
}

interface Totals {
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
// isn't implemented in stage 3, so refuse rather than produce bad data.
const MAX_CHAPTER_WORDS = 13000;

// Rough token model for the confirmation gate; per-model $/MTok rates and the
// per-chapter output estimate come from the resolved model (see ./models).
const EST_TOKENS_PER_WORD = 2.7;
const EST_PROMPT_OVERHEAD_TOKENS = 1200;

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

// The model a checkpoint was extracted with (from its meta). Null when the file
// is unreadable or predates model stamping — callers treat null as "can't
// verify" rather than a mismatch, so legacy checkpoints aren't force-invalidated.
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
      "Usage: tsx src/extract-book.ts <parsed-json-path> [--from N] [--to N] [--skip 11,28] [--dry-run] [--force [12,13]] [--yes] [--rebuild-manifest] [--model <id>] [--out-dir <path>] [--roster <path>]"
    );
  }
  if (opts.from !== null && opts.to !== null && opts.from > opts.to) {
    throw new Error(`--from (${opts.from}) must not exceed --to (${opts.to}).`);
  }
  // A rebuild makes no API calls and exists to reproduce a manifest from the
  // chapter extracts on disk — so its roster must stay purely derived from them.
  // Seeding it would persist operator-supplied entries into the manifest that
  // ADR-0006 makes later stages trust, with nothing on disk to back them.
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

// Stage 3 still owns its own Anthropic call path — only stage 2 goes through the
// extraction seam — so a registry row served by another vendor would end up as a
// foreign model ID inside an Anthropic request. Reject it up front, where the
// message can point somewhere useful, rather than partway into a book.
export function assertProviderSupported(model: ModelInfo): void {
  if (model.provider !== "anthropic") {
    throw new Error(
      `${model.id} is served by ${model.provider}, and extract-book only supports Anthropic models for now. Try it on a single chapter with extract-chapter instead.`
    );
  }
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
  const rates = resolveModel(opts.model).rates;
  const manifest = {
    meta: {
      model: opts.model,
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

export async function extractChapter(
  client: BookExtractionClient,
  book: ParsedBook,
  chapter: ParsedChapter,
  roster: RosterEntry[],
  outPath: string,
  model: string
): Promise<{ extraction: Extraction; usage: Anthropic.Usage }> {
  const systemPrompt = buildSystemPrompt(book.title, roster);

  const response = await client.messages.create({
    model,
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

  const reasoningTokens = anthropicReasoningTokens(response.usage);

  const checkpoint = {
    meta: {
      model: response.model,
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      chapterWordCount: chapter.wordCount,
      rosterSize: roster.length,
      systemPrompt,
      stopReason: response.stop_reason,
      // The vendor's usage object verbatim — the billed counts the manifest
      // sums are unchanged — plus the reasoning split under the seam's
      // normalised name, so that one key at least is spelled the same here as
      // in a stage 2 extract. The rest of this object is still the raw vendor
      // dump, which stage 2's two-count format is not; only the split is
      // common. Anthropic reports it as thinking tokens, and its own nested
      // spelling stays in the dump beside the normalised one.
      usage: {
        ...response.usage,
        ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
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

// Walk every chapter in book order, building the roster and manifest. Narrative
// chapters that willExtract get a (paid) API call; the rest load from their
// checkpoint so the roster carries full context regardless of the extraction
// window. `client === null` is read-only mode (rebuild): nothing is extracted.
async function processChapters(
  plans: ChapterPlan[],
  chunksDir: string,
  book: ParsedBook,
  client: BookExtractionClient | null,
  roster: RosterEntry[],
  manifestChapters: ManifestChapterEntry[],
  totals: Totals,
  toExtractCount: number,
  model: string
): Promise<void> {
  let extractedSoFar = 0;

  for (const plan of plans) {
    const { chapter } = plan;
    const base = { index: chapter.index, title: chapter.title, wordCount: chapter.wordCount };

    if (!plan.narrative) {
      manifestChapters.push({ ...base, status: `skipped:${plan.skipReason!}` });
      continue;
    }

    const outPath = checkpointPath(chunksDir, chapter.index);

    if (client !== null && plan.willExtract) {
      const ordinal = `[${++extractedSoFar}/${toExtractCount}]`;
      const label = `${ordinal} idx ${chapter.index} · ${chapter.title ?? ""}`;
      // Print the prefix without a newline so the in-flight chapter is visible
      // during the (multi-second) API call, then complete the same physical line
      // with the results once it returns — one line per chapter, but still live.
      process.stdout.write(`${label} — extracting (${chapter.wordCount} words, roster ${roster.length})… `);
      const startedAt = performance.now();
      let extraction: Extraction;
      let usage: Anthropic.Usage;
      try {
        ({ extraction, usage } = await extractChapter(client, book, chapter, roster, outPath, model));
      } catch (err) {
        // The prefix above has no newline; terminate the dangling line so the
        // failure message that follows isn't glued onto it.
        process.stdout.write("\n");
        throw err;
      }
      updateRoster(roster, extraction.characters, chapter.index);
      totals.inputTokens += usage.input_tokens;
      totals.outputTokens += usage.output_tokens;
      totals.apiCalls += 1;
      manifestChapters.push({ ...base, status: "extracted", file: path.basename(outPath) });
      // The reasoning split is shown only when the vendor reported one, so a
      // blank stays honest about a model that said nothing.
      const reasoning = anthropicReasoningTokens(usage);
      const reasoningNote = reasoning === undefined ? "" : ` (${reasoning} reasoning)`;
      console.log(
        `done · ${extraction.characters.length} chars, ${extraction.relationships.length} rels, ${extraction.events.length} events · ${usage.input_tokens}/${usage.output_tokens}${reasoningNote} tok · ${formatDuration(performance.now() - startedAt)}`
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
  assertProviderSupported(model);
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
    await processChapters(plans, chunksDir, book, null, roster, manifestChapters, totals, 0, opts.model);
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
    await processChapters(plans, chunksDir, book, client, roster, manifestChapters, totals, toExtract.length, opts.model);
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
    if (err instanceof Anthropic.APIError) {
      console.error(`API error ${err.status}: ${err.message}`);
    } else {
      console.error(`Extraction failed: ${err instanceof Error ? err.message : err}`);
    }
    console.error("Any checkpoints already written are preserved; rerun to resume.");
    process.exitCode = 1;
  });
}
