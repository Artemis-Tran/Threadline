import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractChapter,
  parseArgs,
  planChapters,
  planStatus,
  estimateCostUsd,
  costUsd,
  checkpointPath,
  chapterIndexLines,
  assertForceIndicesInRange,
  assertCheckpointModelsMatch,
  indexFromCheckpoint,
  readCheckpointCharacters,
  updateRoster,
  readRosterFile,
  buildSystemPrompt,
  CliOptions,
  ChapterRunInput,
  processChapters,
} from "../src/extract-book";
import { ExtractionClient } from "../src/extraction-call";
import { ParsedBook, ParsedChapter, RosterEntry, ExtractedCharacter, Extraction } from "../src/types";
import { resolveModel } from "../src/models";

const SONNET_MODEL = resolveModel("claude-sonnet-5");
const SONNET = SONNET_MODEL.rates;

// --- fixtures ------------------------------------------------------------

function defaultOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    parsedJsonPath: "book-parsed.json",
    list: false,
    from: null,
    to: null,
    skip: new Set(),
    dryRun: false,
    forceAll: false,
    forceIndices: new Set(),
    yes: false,
    rebuildManifest: false,
    model: "claude-sonnet-5",
    outDir: null,
    rosterPath: null,
    ...overrides,
  };
}

function chapter(index: number, title: string, wordCount: number): ParsedChapter {
  return { index, id: `ch${index}`, href: `ch${index}.html`, title, wordCount, text: "text" };
}

function book(chapters: ParsedChapter[]): ParsedBook {
  return {
    sourceFile: "/x/book.epub",
    title: "Test Book",
    creator: null,
    language: null,
    chapterCount: chapters.length,
    wordCount: chapters.reduce((s, c) => s + c.wordCount, 0),
    chapters,
  };
}

function extractedCharacter(name: string, overrides: Partial<ExtractedCharacter> = {}): ExtractedCharacter {
  return { name, aliases: [], description: `${name} description`, role: "minor", ...overrides };
}

// Write `contents` to a throwaway roster file, run `fn` against its path, and
// clean up either way.
function withRosterFile(contents: string, fn: (rosterPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-roster-"));
  try {
    const rosterPath = path.join(dir, "roster.json");
    fs.writeFileSync(rosterPath, contents, "utf-8");
    fn(rosterPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- vendor response doubles ---------------------------------------------
//
// The extract step goes through the extraction seam, which constructs a real
// SDK client when handed none — so every test here injects one. Nothing below
// reaches a live API or spends anything.
//
// The doubles are shaped to the seam's client interfaces rather than to the
// SDKs', which is why no vendor SDK is imported: the seam declares only the
// slice of a response it reads, so a canned payload does not have to satisfy
// every field a real one carries.

// Just enough of an Anthropic usage payload for the seam. The reasoning split
// arrives nested inside it, which is the shape being normalised.
type AnthropicUsagePayload = {
  input_tokens: number;
  output_tokens: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
};

function anthropicUsage(overrides: Partial<AnthropicUsagePayload> = {}): AnthropicUsagePayload {
  return { input_tokens: 1200, output_tokens: 340, ...overrides };
}

function extractionOf(...names: string[]): Extraction {
  return { characters: names.map((n) => extractedCharacter(n)), relationships: [], events: [] };
}

// One scripted answer. `text: null` means a response carrying no text block,
// which is a different failure from a refusal and has to stay tellable apart.
interface CannedResponse {
  stop_reason?: string | null;
  text?: string | null;
  usage?: AnthropicUsagePayload;
}

// What Anthropic answers a `claude-sonnet-5` request with: an alias resolved to
// a dated snapshot. It is not a registry ID, so an extract stamped with it can
// be neither priced nor matched by the reuse guard — which is the whole reason
// the requested ID is what gets stamped.
const SERVED_SNAPSHOT = "claude-sonnet-5-20260101";

// The same trick on the OpenAI side, where an alias resolves to a dated
// snapshot just as readily.
const OPENAI_SERVED_SNAPSHOT = "gpt-5.6-luna-2026-04-02";

const LUNA_MODEL = resolveModel("gpt-5.6-luna");

// The captured request, narrowed to what a test asserts on. Both vendors' bodies
// are read through their own alias so the parameter names stay visible — the
// prompt travels as `system` for one and `instructions` for the other.
type CapturedAnthropicRequest = { model: string; max_tokens: number; system?: unknown };
type CapturedOpenAIRequest = { model: string; max_output_tokens: number; instructions?: unknown };

function cannedResponse(canned: CannedResponse) {
  const text = canned.text === undefined ? JSON.stringify(extractionOf("Henry")) : canned.text;
  return {
    model: SERVED_SNAPSHOT,
    stop_reason: canned.stop_reason === undefined ? "end_turn" : canned.stop_reason,
    content: text === null ? [] : [{ type: "text" as const, text }],
    usage: canned.usage ?? anthropicUsage(),
  };
}

// Answers each call from the script in order and records what it was asked, so
// a test can assert on the prompt the *second* chapter was sent — the only
// externally visible evidence that the first chapter's roster carried forward.
function scriptedClient(script: CannedResponse[]): {
  client: ExtractionClient;
  requests: CapturedAnthropicRequest[];
} {
  const requests: CapturedAnthropicRequest[] = [];
  return {
    requests,
    client: {
      messages: {
        async create(body) {
          const canned = script[requests.length];
          requests.push(body as unknown as CapturedAnthropicRequest);
          if (canned === undefined) throw new Error(`unscripted API call #${requests.length}`);
          return cannedResponse(canned);
        },
      },
    },
  };
}

// OpenAI reports failure differently from Anthropic — a refusal is a content
// part, truncation is a status plus a separate reason — so a canned answer here
// is described in those terms rather than by a stop reason.
interface CannedOpenAIResponse {
  status?: string;
  incompleteReason?: string;
  text?: string | null;
  refusal?: string;
  reasoningTokens?: number;
}

function cannedOpenAIResponse(canned: CannedOpenAIResponse) {
  const text = canned.text === undefined ? JSON.stringify(extractionOf("Henry")) : canned.text;
  const parts = [
    ...(text === null ? [] : [{ type: "output_text" as const, text }]),
    ...(canned.refusal === undefined ? [] : [{ type: "refusal" as const, refusal: canned.refusal }]),
  ];
  return {
    model: OPENAI_SERVED_SNAPSHOT,
    status: canned.status ?? "completed",
    incomplete_details: canned.incompleteReason === undefined ? null : { reason: canned.incompleteReason },
    // A reasoning item precedes the message in a real response; including one
    // keeps the double honest about the scan the seam has to do.
    output: [{ type: "reasoning" as const }, { type: "message" as const, content: parts }],
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      output_tokens_details:
        canned.reasoningTokens === undefined ? null : { reasoning_tokens: canned.reasoningTokens },
    },
  };
}

function scriptedOpenAIClient(script: CannedOpenAIResponse[]): {
  client: ExtractionClient;
  requests: CapturedOpenAIRequest[];
} {
  const requests: CapturedOpenAIRequest[] = [];
  return {
    requests,
    client: {
      responses: {
        async create(body) {
          const canned = script[requests.length];
          requests.push(body as unknown as CapturedOpenAIRequest);
          if (canned === undefined) throw new Error(`unscripted API call #${requests.length}`);
          return cannedOpenAIResponse(canned);
        },
      },
    },
  };
}

// processChapters writes a live progress line per chapter; swallow it so the
// suite stays readable. Restored on the way out, including on a throw.
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

// --- parseArgs -----------------------------------------------------------

describe("parseArgs", () => {
  test("throws usage error without a path", () => {
    assert.throws(() => parseArgs([]), /Usage:/);
  });

  test("parses the full flag set", () => {
    const opts = parseArgs(["book.json", "--from", "2", "--to", "9", "--skip", "3,5", "--dry-run", "--yes"]);
    assert.equal(opts.parsedJsonPath, "book.json");
    assert.equal(opts.from, 2);
    assert.equal(opts.to, 9);
    assert.deepEqual([...opts.skip].sort(), [3, 5]);
    assert.equal(opts.dryRun, true);
    assert.equal(opts.yes, true);
  });

  test("bare --force means force-all; --force with a list targets indices", () => {
    const all = parseArgs(["book.json", "--force"]);
    assert.equal(all.forceAll, true);
    assert.equal(all.forceIndices.size, 0);

    const some = parseArgs(["book.json", "--force", "12,13"]);
    assert.equal(some.forceAll, false);
    assert.deepEqual([...some.forceIndices].sort(), [12, 13]);
  });

  test("rejects negative or non-integer --from/--to", () => {
    assert.throws(() => parseArgs(["b", "--from", "-1"]), /non-negative integer/);
    assert.throws(() => parseArgs(["b", "--to", "abc"]), /non-negative integer/);
  });

  test("rejects --from greater than --to", () => {
    assert.throws(() => parseArgs(["b", "--from", "9", "--to", "2"]), /must not exceed/);
  });

  test("rejects a malformed --skip list", () => {
    assert.throws(() => parseArgs(["b", "--skip", "3;5"]), /--skip expects/);
  });

  test("rejects unknown flags and extra positionals", () => {
    assert.throws(() => parseArgs(["b", "--frob"]), /Unknown flag/);
    assert.throws(() => parseArgs(["a", "b"]), /Unexpected argument/);
  });

  test("defaults to Sonnet and resolves --model aliases and full IDs", () => {
    assert.equal(parseArgs(["book.json"]).model, "claude-sonnet-5");
    assert.equal(parseArgs(["book.json", "--model", "haiku"]).model, "claude-haiku-4-5");
    assert.equal(parseArgs(["book.json", "--model", "claude-opus-4-8"]).model, "claude-opus-4-8");
  });

  test("rejects an unknown or valueless --model", () => {
    assert.throws(() => parseArgs(["book.json", "--model", "gpt-5.6-sol"]), /Unknown model/);
    assert.throws(() => parseArgs(["book.json", "--model"]), /--model expects/);
  });

  test("--out-dir overrides the chunks dir; defaults to null", () => {
    assert.equal(parseArgs(["book.json"]).outDir, null);
    assert.equal(parseArgs(["book.json", "--out-dir", "output/ab-haiku"]).outDir, "output/ab-haiku");
    assert.throws(() => parseArgs(["book.json", "--out-dir"]), /--out-dir expects/);
    assert.throws(() => parseArgs(["book.json", "--out-dir", "--yes"]), /--out-dir expects/);
  });

  test("--roster carries a path; defaults to null", () => {
    assert.equal(parseArgs(["book.json"]).rosterPath, null);
    assert.equal(parseArgs(["book.json", "--roster", "probe-roster.json"]).rosterPath, "probe-roster.json");
    assert.throws(() => parseArgs(["book.json", "--roster"]), /--roster expects/);
    assert.throws(() => parseArgs(["book.json", "--roster", "--yes"]), /--roster expects/);
  });

  test("rejects --roster alongside --rebuild-manifest", () => {
    // A rebuild's roster has to stay derived from the chapter extracts on disk,
    // or the manifest asserts characters nothing on disk backs.
    assert.throws(
      () => parseArgs(["book.json", "--roster", "r.json", "--rebuild-manifest"]),
      /cannot be combined with --rebuild-manifest/
    );
    assert.throws(
      () => parseArgs(["book.json", "--rebuild-manifest", "--roster", "r.json"]),
      /cannot be combined with --rebuild-manifest/
    );
  });
});

// --- the chapter index listing ---------------------------------------------

describe("--list / chapterIndexLines", () => {
  test("parseArgs treats --list as a flag, defaulting to off", () => {
    assert.equal(parseArgs(["book.json"]).list, false);
    assert.equal(parseArgs(["book.json", "--list"]).list, true);
  });

  test("renders one line per flow item, index first", () => {
    const lines = chapterIndexLines(book([chapter(0, "Contents", 40), chapter(1, "The Wheel", 3900)]));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\s+0 \|\s+40 words \| Contents$/);
    assert.match(lines[1], /^\s+1 \|\s+3900 words \| The Wheel$/);
  });

  test("falls back to the opening line when a flow item has no title", () => {
    const untitled = { ...chapter(3, "x", 120), title: null, text: "A cold morning\nand then more" };
    assert.match(chapterIndexLines(book([untitled]))[0], /A cold morning$/);
  });
});

// --- forced index range ------------------------------------------------------

describe("assertForceIndicesInRange", () => {
  test("accepts every index the book has, and an empty set", () => {
    assert.doesNotThrow(() => assertForceIndicesInRange(new Set(), 3));
    assert.doesNotThrow(() => assertForceIndicesInRange(new Set([0, 2]), 3));
  });

  test("names the bad index and the real range rather than the flags used to select it", () => {
    // The single-chapter probe forwards --force, so a mistyped chapter index
    // arrives here — the message has to be about the index, not about
    // --from/--to/--skip, which that operator never typed.
    assert.throws(() => assertForceIndicesInRange(new Set([999]), 52), (err: Error) => {
      assert.match(err.message, /No such chapter: 999/);
      assert.match(err.message, /\[0, 51\]/);
      assert.match(err.message, /--list/);
      assert.doesNotMatch(err.message, /--from/);
      return true;
    });
  });

  test("reports every out-of-range index, in order, keeping the valid ones quiet", () => {
    assert.throws(() => assertForceIndicesInRange(new Set([7, 12, 3]), 5), /No such chapter: 7, 12\./);
  });
});

// --- cost math -------------------------------------------------------------

describe("costUsd / estimateCostUsd", () => {
  test("costUsd applies the model's $/MTok rates, rounded to cents", () => {
    assert.equal(costUsd(1_000_000, 0, SONNET), 3);
    assert.equal(costUsd(0, 1_000_000, SONNET), 15);
    assert.equal(costUsd(1000, 1000, SONNET), 0.02); // $0.018 rounds to 2 cents
    assert.equal(costUsd(0, 0, SONNET), 0);
  });

  test("costUsd tracks per-model rates (Haiku is cheaper than Sonnet)", () => {
    const haiku = resolveModel("haiku").rates;
    assert.equal(costUsd(1_000_000, 0, haiku), 1);
    assert.equal(costUsd(0, 1_000_000, haiku), 5);
  });

  test("estimateCostUsd counts only willExtract chapters", () => {
    const plans = planChapters(
      book([chapter(0, "Chapter 1", 1000), chapter(1, "Chapter 2", 1000)]),
      defaultOpts({ skip: new Set([1]) }),
      "/nonexistent-chunks-dir"
    );
    // one chapter: (1000*2.7 + 1200) tokens in, 2000 out — the same numbers as
    // before the output estimate moved onto the registry row.
    const expected = (3900 * 3 + 2000 * 15) / 1e6;
    assert.ok(Math.abs(estimateCostUsd(plans, SONNET_MODEL) - expected) < 1e-9);
  });

  test("estimateCostUsd budgets output from the model's own estimate", () => {
    const plans = planChapters(
      book([chapter(0, "Chapter 1", 1000)]),
      defaultOpts(),
      "/nonexistent-chunks-dir"
    );
    // Each row's estimate is charged rather than a single global figure. The
    // input side is the same 3900 tokens Sonnet is charged for above — the
    // per-word constant is deliberately shared, and over-estimates OpenAI.
    const luna = resolveModel("luna");
    const expected = (3900 * 0.2 + 1290 * 1.2) / 1e6;
    assert.equal(luna.outputTokenEstimate, 1290);
    assert.ok(Math.abs(estimateCostUsd(plans, luna) - expected) < 1e-9);
  });
});

// --- checkpoint paths ---------------------------------------------------------

describe("checkpointPath / indexFromCheckpoint", () => {
  test("zero-pads the chapter index to three digits", () => {
    assert.equal(path.basename(checkpointPath("/chunks", 4)), "idx004-extract.json");
    assert.equal(path.basename(checkpointPath("/chunks", 123)), "idx123-extract.json");
  });

  test("indexFromCheckpoint recovers the index for --force hints", () => {
    assert.equal(indexFromCheckpoint("/chunks/idx012-extract.json"), "12");
    assert.equal(indexFromCheckpoint("/chunks/unrelated.json"), "<index>");
  });
});

// --- cross-model checkpoint guard -----------------------------------------

describe("assertCheckpointModelsMatch", () => {
  const chapters = [chapter(0, "Chapter 1", 1500)];

  // `meta` verbatim, so a test can write the pre-migration shape (a served
  // snapshot under `model`) as well as the post-migration one.
  function withCheckpoint(meta: Record<string, unknown> | null, run: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-model-"));
    try {
      const body = meta === null ? "{}" : JSON.stringify({ meta, extraction: { characters: [] } });
      fs.writeFileSync(checkpointPath(dir, 0), body);
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("passes when a cached checkpoint's model matches --model", () => {
    withCheckpoint({ model: "claude-sonnet-5" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.doesNotThrow(() => assertCheckpointModelsMatch(plans, dir, "claude-sonnet-5"));
    });
  });

  test("throws when a cached checkpoint was written by a different model", () => {
    withCheckpoint({ model: "claude-sonnet-5" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.throws(() => assertCheckpointModelsMatch(plans, dir, "claude-haiku-4-5"), /Model mismatch/);
    });
  });

  // The comparison is exact, and stays exact. A dated snapshot is not the
  // registry ID it was resolved from, and teaching the guard to accept one by
  // prefix would put a second, weaker source of truth about model identity in
  // the one place guarding paid output — and could not tell a snapshot from a
  // different model whose ID merely extends another's.
  test("throws on a checkpoint stamped with the vendor's dated snapshot ID", () => {
    withCheckpoint({ model: "claude-sonnet-5-20260101" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.throws(() => assertCheckpointModelsMatch(plans, dir, "claude-sonnet-5"), /Model mismatch/);
    });
  });

  // The payoff of stamping the requested ID: the guard matches on `model` and
  // is unbothered by whatever the vendor called itself.
  test("passes when the requested ID matches and a served snapshot sits beside it", () => {
    withCheckpoint({ model: "claude-sonnet-5", modelReturned: "claude-sonnet-5-20260101" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.doesNotThrow(() => assertCheckpointModelsMatch(plans, dir, "claude-sonnet-5"));
    });
  });

  test("ignores a legacy checkpoint with no model stamp", () => {
    withCheckpoint(null, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.doesNotThrow(() => assertCheckpointModelsMatch(plans, dir, "claude-haiku-4-5"));
    });
  });

  test("does not check checkpoints that will be re-extracted (--force)", () => {
    withCheckpoint({ model: "claude-sonnet-5" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts({ forceAll: true }), dir);
      assert.doesNotThrow(() => assertCheckpointModelsMatch(plans, dir, "claude-haiku-4-5"));
    });
  });

  test("in rebuild mode, forced-index checkpoints are loaded from cache so they ARE checked", () => {
    withCheckpoint({ model: "claude-sonnet-5" }, (dir) => {
      const plans = planChapters(book(chapters), defaultOpts({ forceAll: true }), dir);
      // rebuildMode = true: nothing is extracted, so a mismatched forced index must still throw.
      assert.throws(() => assertCheckpointModelsMatch(plans, dir, "claude-haiku-4-5", true), /Model mismatch/);
    });
  });
});

// --- chapter planning -----------------------------------------------------------

describe("planChapters", () => {
  const chapters = [
    chapter(0, "Title Page", 8), // skip: word-count
    chapter(1, "Chapter 1", 1500),
    chapter(2, "Chapter 2", 1500),
    chapter(3, "Afterword", 419), // skip: title (above word threshold)
  ];

  test("applies word-count and title skip heuristics", () => {
    const plans = planChapters(book(chapters), defaultOpts(), "/nonexistent");
    assert.deepEqual(plans.map(planStatus), ["skip:word-count", "extract", "extract", "skip:title"]);
  });

  test("a checkpoint on disk makes a chapter cached instead of extract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-plan-"));
    try {
      fs.writeFileSync(checkpointPath(dir, 1), "{}");
      const plans = planChapters(book(chapters), defaultOpts(), dir);
      assert.equal(planStatus(plans[1]), "cached");
      assert.equal(planStatus(plans[2]), "extract");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bare --force re-extracts cached chapters but never drags in front matter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-plan-"));
    try {
      fs.writeFileSync(checkpointPath(dir, 1), "{}");
      const plans = planChapters(book(chapters), defaultOpts({ forceAll: true }), dir);
      assert.equal(planStatus(plans[0]), "skip:word-count");
      assert.equal(planStatus(plans[1]), "extract");
      assert.equal(planStatus(plans[3]), "skip:title");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicitly forced index overrides skip heuristics AND the window", () => {
    const plans = planChapters(
      book(chapters),
      defaultOpts({ from: 1, to: 2, forceIndices: new Set([3]) }),
      "/nonexistent"
    );
    assert.equal(plans[3].narrative, true);
    assert.equal(planStatus(plans[3]), "extract");
  });

  test("chapters outside --from/--to (or in --skip) become pending, not skipped", () => {
    const plans = planChapters(
      book(chapters),
      defaultOpts({ from: 2, skip: new Set([2]) }),
      "/nonexistent"
    );
    assert.equal(planStatus(plans[1]), "pending"); // outside window, narrative, no checkpoint
    assert.equal(planStatus(plans[2]), "pending"); // skipped this run, still narrative
  });
});

// --- checkpoint reading -----------------------------------------------------------

describe("readCheckpointCharacters", () => {
  function withTempFile(content: string, fn: (p: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-ckpt-"));
    const p = path.join(dir, "idx007-extract.json");
    try {
      fs.writeFileSync(p, content);
      fn(p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("returns the characters array from a valid checkpoint", () => {
    const characters = [extractedCharacter("Henry")];
    withTempFile(JSON.stringify({ extraction: { characters } }), (p) => {
      assert.deepEqual(readCheckpointCharacters(p), characters);
    });
  });

  test("invalid JSON names the file and the --force index", () => {
    withTempFile("{ not json", (p) => {
      assert.throws(() => readCheckpointCharacters(p), /idx007-extract\.json.*--force 7/);
    });
  });

  test("missing characters array names the file and the --force index", () => {
    withTempFile(JSON.stringify({ extraction: {} }), (p) => {
      assert.throws(() => readCheckpointCharacters(p), /no valid extraction\.characters.*--force 7/);
    });
  });
});

// --- roster hint maintenance -----------------------------------------------------------

describe("updateRoster", () => {
  test("creates capped entries: 8 aliases max, 150-char description", () => {
    const roster: RosterEntry[] = [];
    const aliases = Array.from({ length: 12 }, (_, i) => `Epithet ${i}`);
    updateRoster(roster, [extractedCharacter("Henry", { aliases, description: "x".repeat(300) })], 4);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].aliases.length, 8);
    assert.equal(roster[0].description.length, 150);
    assert.equal(roster[0].firstAppearedChapterIndex, 4);
    assert.equal(roster[0].lastAppearedChapterIndex, 4);
  });

  test("matches an existing entry by bare name and accumulates new aliases up to the cap", () => {
    const roster: RosterEntry[] = [];
    updateRoster(roster, [extractedCharacter("Henry")], 4);
    updateRoster(roster, [extractedCharacter("Henry", { aliases: ["Mystic Potter"] })], 10);
    assert.equal(roster.length, 1);
    assert.deepEqual(roster[0].aliases, ["Mystic Potter"]);
    assert.equal(roster[0].firstAppearedChapterIndex, 4);
    assert.equal(roster[0].lastAppearedChapterIndex, 10);
  });

  test("description merge is longest-wins by design (the roster is a lossy hint — stage 4 owns recency)", () => {
    const roster: RosterEntry[] = [];
    updateRoster(roster, [extractedCharacter("Henry", { description: "a long and detailed early description" })], 4);
    updateRoster(roster, [extractedCharacter("Henry", { description: "short late one" })], 50);
    assert.equal(roster[0].description, "a long and detailed early description");
  });

  test("matches via alias overlap, not just name", () => {
    const roster: RosterEntry[] = [];
    updateRoster(roster, [extractedCharacter("Henry", { aliases: ["Mystic Potter"] })], 4);
    updateRoster(roster, [extractedCharacter("Mystic Potter")], 20);
    assert.equal(roster.length, 1);
  });

  test("sanitizes parenthetical names and skips empties", () => {
    const roster: RosterEntry[] = [];
    updateRoster(roster, [extractedCharacter("Marcus (blacksmith's apprentice)"), extractedCharacter("(the guard)")], 4);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].name, "Marcus");
  });

  test("filters generic aliases before they can chain characters together", () => {
    const roster: RosterEntry[] = [];
    updateRoster(roster, [extractedCharacter("Henry", { aliases: ["him", "his brother", "the potter"] })], 4);
    assert.deepEqual(roster[0].aliases, []);
  });
});

// --- supplied roster file ----------------------------------------------------

// Every case here runs before any API call would be made, so a rejected file
// costs nothing — that's the property these tests exist to pin down.
describe("readRosterFile", () => {
  const VALID: RosterEntry[] = [
    {
      name: "Henry Ashford",
      aliases: ["Young Master Ashford"],
      description: "a potter's apprentice",
      firstAppearedChapterIndex: 4,
      lastAppearedChapterIndex: 9,
    },
  ];

  test("reads a JSON array of roster entries", () => {
    withRosterFile(JSON.stringify(VALID), (rosterPath) => {
      assert.deepEqual(readRosterFile(rosterPath), VALID);
    });
  });

  test("accepts an empty array as an empty roster", () => {
    withRosterFile("[]", (rosterPath) => {
      assert.deepEqual(readRosterFile(rosterPath), []);
    });
  });

  test("entries are taken verbatim, not re-normalized like an accumulated roster", () => {
    // updateRoster would strip the parenthetical, drop the generic alias, and
    // truncate the description. A supplied roster is deliberately exempt: the
    // flag exists to hand the model an adversarial roster, and silently
    // rewriting the operator's file would defeat that.
    const adversarial = [
      {
        name: "Marcus (blacksmith's apprentice)",
        aliases: ["his brother"],
        description: "x".repeat(400),
        firstAppearedChapterIndex: 0,
        lastAppearedChapterIndex: 0,
      },
    ];
    withRosterFile(JSON.stringify(adversarial), (rosterPath) => {
      assert.deepEqual(readRosterFile(rosterPath), adversarial);
    });
  });

  test("rejects a missing file", () => {
    assert.throws(() => readRosterFile("/nonexistent/roster.json"), /--roster file not found/);
  });

  test("rejects unparseable JSON", () => {
    withRosterFile("{not json", (rosterPath) => {
      assert.throws(() => readRosterFile(rosterPath), /--roster file is not valid JSON/);
    });
  });

  test("rejects a top-level value that is not an array", () => {
    withRosterFile('"Henry"', (rosterPath) => {
      assert.throws(() => readRosterFile(rosterPath), /must contain a JSON array/);
    });
  });

  test("points a whole manifest at its roster array rather than just refusing", () => {
    withRosterFile(JSON.stringify({ meta: {}, chapters: [], roster: VALID }), (rosterPath) => {
      assert.throws(() => readRosterFile(rosterPath), /pass its `roster` array/);
    });
  });

  test("names the offending entry and field", () => {
    const cases: [unknown, RegExp][] = [
      ["Henry", /entry 0 .*object/],
      [{ ...VALID[0], name: "" }, /entry 0 .*`name`/],
      [{ ...VALID[0], name: 42 }, /entry 0 .*`name`/],
      [{ ...VALID[0], aliases: "Ash" }, /entry 0 .*`aliases`/],
      [{ ...VALID[0], aliases: ["Ash", 7] }, /entry 0 .*`aliases`/],
      [{ ...VALID[0], description: null }, /entry 0 .*`description`/],
      [{ ...VALID[0], firstAppearedChapterIndex: "4" }, /entry 0 .*`firstAppearedChapterIndex`/],
      [{ ...VALID[0], lastAppearedChapterIndex: -1 }, /entry 0 .*`lastAppearedChapterIndex`/],
    ];
    for (const [entry, expected] of cases) {
      withRosterFile(JSON.stringify([entry]), (rosterPath) => {
        assert.throws(() => readRosterFile(rosterPath), expected);
      });
    }
  });

  test("reports the position of a bad entry later in the array", () => {
    withRosterFile(JSON.stringify([VALID[0], { ...VALID[0], description: 3 }]), (rosterPath) => {
      assert.throws(() => readRosterFile(rosterPath), /entry 1 /);
    });
  });
});

// --- system prompt -----------------------------------------------------------

describe("extract-book buildSystemPrompt", () => {
  test("without a roster, no known-characters section is included", () => {
    const prompt = buildSystemPrompt("Test Book", []);
    assert.match(prompt, /"Test Book"/);
    assert.doesNotMatch(prompt, /Characters known so far/);
  });

  test("with a roster, lists entries and pins exact name usage", () => {
    const roster: RosterEntry[] = [
      { name: "Henry", aliases: ["Mystic Potter"], description: "a potter", firstAppearedChapterIndex: 4, lastAppearedChapterIndex: 10 },
    ];
    const prompt = buildSystemPrompt("Test Book", roster);
    assert.match(prompt, /Characters known so far/);
    assert.match(prompt, /- name: Henry \| also called: Mystic Potter \| a potter/);
    assert.match(prompt, /use exactly the listed `name:` value/);
  });

  // The point of the --roster flag: a one-chapter probe must send the same
  // request a chapter deep into a book would send. If a supplied roster and an
  // accumulated one could produce different prompts, the probe would be
  // measuring the flag rather than the model.
  test("a supplied roster produces a byte-identical prompt to an accumulated one", () => {
    const accumulated: RosterEntry[] = [];
    updateRoster(
      accumulated,
      [
        extractedCharacter("Henry Ashford", { aliases: ["Young Master Ashford"] }),
        extractedCharacter("Mira", { aliases: ["the Mystic Potter"] }),
      ],
      4
    );
    updateRoster(accumulated, [extractedCharacter("Henry Ashford", { description: "a longer description" })], 7);

    withRosterFile(JSON.stringify(accumulated, null, 2), (rosterPath) => {
      assert.equal(
        buildSystemPrompt("Test Book", readRosterFile(rosterPath)),
        buildSystemPrompt("Test Book", accumulated)
      );
    });
  });
});

// --- the chapter extract writer -------------------------------------------
//
// Stage 3 still builds its own Anthropic request rather than going through the
// extraction seam (ADR-0008), so its extract writer needs its own coverage. The
// client is injected, so nothing here reaches a live API or spends anything.

describe("extractChapter", () => {
  function fakeClient(responseUsage: AnthropicUsagePayload): ExtractionClient {
    return scriptedClient([{ usage: responseUsage }]).client;
  }

  // Read back off disk, so the assertions are about the file a later stage
  // actually gets — not about an in-memory object that never round-tripped.
  type WrittenUsage = { input_tokens?: unknown; output_tokens?: unknown; reasoning_tokens?: unknown };
  type WrittenMeta = { model?: unknown; modelReturned?: unknown; usage: WrittenUsage };

  async function writtenMeta(responseUsage: AnthropicUsagePayload): Promise<WrittenMeta> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-extract-"));
    try {
      const outPath = path.join(dir, "idx004-extract.json");
      await extractChapter(
        fakeClient(responseUsage),
        book([chapter(4, "One", 900)]),
        chapter(4, "One", 900),
        [],
        outPath,
        SONNET_MODEL
      );
      return (JSON.parse(fs.readFileSync(outPath, "utf-8")) as { meta: WrittenMeta }).meta;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function writtenUsage(responseUsage: AnthropicUsagePayload): Promise<WrittenUsage> {
    return (await writtenMeta(responseUsage)).usage;
  }

  // The stamping ADR-0008 chose, and the reason this run's own extracts are
  // reusable at all: `model` is the registry ID that was asked for, so the reuse
  // guard and the pricing table can both look it up.
  test("stamps the requested registry ID, not the string the vendor served", async () => {
    const meta = await writtenMeta(anthropicUsage());
    assert.equal(meta.model, "claude-sonnet-5");
  });

  test("keeps the vendor's returned string beside it", async () => {
    const meta = await writtenMeta(anthropicUsage());
    assert.equal(meta.modelReturned, SERVED_SNAPSHOT);
  });

  test("stamps the reasoning split under the seam's normalised name", async () => {
    const written = await writtenUsage(anthropicUsage({ output_tokens_details: { thinking_tokens: 214 } }));
    assert.equal(written.reasoning_tokens, 214);
  });

  test("omits the reasoning count when the vendor reported no detail", async () => {
    // Absent, not zero — see ExtractionUsage.reasoningTokens.
    const written = await writtenUsage(anthropicUsage());
    assert.equal("reasoning_tokens" in written, false);
  });

  test("leaves the billed counts the manifest sums untouched", async () => {
    const written = await writtenUsage(anthropicUsage({ output_tokens_details: { thinking_tokens: 214 } }));
    assert.equal(written.input_tokens, 1200);
    // The split decomposes the output count rather than adding to it.
    assert.equal(written.output_tokens, 340);
  });
});

// --- the per-chapter walk --------------------------------------------------
//
// The code path that spends the money — reachable at all only since the rebuild
// mode and the client stopped sharing one parameter (see ChapterRunInput).

describe("processChapters", () => {
  async function withChunksDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-run-"));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Put a chapter extract on disk, as a previous run would have left it.
  function seedExtract(dir: string, index: number, ...names: string[]): void {
    fs.writeFileSync(checkpointPath(dir, index), JSON.stringify({ extraction: extractionOf(...names) }), "utf-8");
  }

  function runInput(over: Partial<ChapterRunInput> & Pick<ChapterRunInput, "plans" | "chunksDir" | "book">): ChapterRunInput {
    return {
      model: SONNET_MODEL,
      roster: [],
      manifestChapters: [],
      totals: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
      toExtractCount: over.plans.filter((p) => p.willExtract).length,
      ...over,
    };
  }

  const TWO_CHAPTERS = book([chapter(4, "One", 900), chapter(5, "Two", 900)]);

  describe("a failed chapter aborts the run", () => {
    // Each of the three ways a chapter can come back unusable must stop the
    // run rather than write an extract. Whichever one it is has to stay legible
    // in the message: a refusal will not succeed on a retry, a truncation will
    // with a bigger budget, and a missing text block is neither.
    const failures: Array<[string, CannedResponse, RegExp]> = [
      ["a refusal", { stop_reason: "refusal", text: null }, /refused/],
      ["truncation", { stop_reason: "max_tokens", text: '{"characters":[{"na' }, /truncated at \d+ tokens/],
      ["no usable text", { stop_reason: "tool_use", text: null }, /no usable text/],
      // Text is not evidence the answer is finished. A stop reason the seam
      // could only normalise to "other", carrying parseable JSON, is still a
      // response the model never said it had completed — writing it would put a
      // half-answer into the thread wearing a complete one's clothes.
      [
        "an unusable stop reason that still carried text",
        { stop_reason: "tool_use", text: JSON.stringify({ characters: [], relationships: [], events: [] }) },
        /no usable text \(stop reason: other\)/,
      ],
    ];

    for (const [name, canned, message] of failures) {
      test(`${name} aborts before the extract is written`, async () => {
        await withChunksDir(async (dir) => {
          const book1 = book([chapter(4, "One", 900)]);
          const plans = planChapters(book1, defaultOpts(), dir);
          const { client } = scriptedClient([canned]);

          await assert.rejects(
            () => quiet(() => processChapters(runInput({ plans, chunksDir: dir, book: book1, client }))),
            message
          );
          assert.equal(fs.existsSync(checkpointPath(dir, 4)), false);
        });
      });
    }

    test("truncated output is preserved beside the extract before the abort", async () => {
      await withChunksDir(async (dir) => {
        const book1 = book([chapter(4, "One", 900)]);
        const plans = planChapters(book1, defaultOpts(), dir);
        const { client } = scriptedClient([{ stop_reason: "max_tokens", text: '{"characters":[{"na' }]);

        await assert.rejects(() =>
          quiet(() => processChapters(runInput({ plans, chunksDir: dir, book: book1, client })))
        );

        // Paid output; losing it silently would be the whole cost of the call.
        const truncated = checkpointPath(dir, 4).replace(/\.json$/, "-truncated.txt");
        assert.equal(fs.readFileSync(truncated, "utf-8"), '{"characters":[{"na');
      });
    });
  });

  test("carries the roster forward from one chapter into the next chapter's prompt", async () => {
    await withChunksDir(async (dir) => {
      const plans = planChapters(TWO_CHAPTERS, defaultOpts(), dir);
      const { client, requests } = scriptedClient([
        { text: JSON.stringify(extractionOf("Henry Ashford")) },
        { text: JSON.stringify(extractionOf("Mira")) },
      ]);
      const input = runInput({ plans, chunksDir: dir, book: TWO_CHAPTERS, client });

      await quiet(() => processChapters(input));

      assert.equal(requests.length, 2);
      // The first chapter has nothing behind it, so its prompt carries no roster.
      assert.equal(/Characters known so far/.test(String(requests[0].system)), false);
      // The second one does — this is the carry-forward the whole stage exists for.
      assert.match(String(requests[1].system), /Characters known so far.*Henry Ashford/s);
      assert.deepEqual(input.roster.map((r) => r.name), ["Henry Ashford", "Mira"]);
    });
  });

  test("routes each chapter to extracted, cached, or pending, and says so in the manifest", async () => {
    await withChunksDir(async (dir) => {
      const b = book([
        chapter(3, "Foreword", 100), // too short to be narrative
        chapter(4, "One", 900), // no extract on disk, in the window → extracted
        chapter(5, "Two", 900), // extract on disk → cached
        chapter(6, "Three", 900), // skipped this run, nothing on disk → pending
      ]);
      seedExtract(dir, 5, "Mira");
      const plans = planChapters(b, defaultOpts({ skip: new Set([6]) }), dir);
      const { client, requests } = scriptedClient([{ text: JSON.stringify(extractionOf("Henry Ashford")) }]);
      const input = runInput({ plans, chunksDir: dir, book: b, client });

      await quiet(() => processChapters(input));

      assert.deepEqual(
        input.manifestChapters.map((c) => [c.index, c.status, c.file]),
        [
          [3, "skipped:word-count", undefined],
          [4, "extracted", "idx004-extract.json"],
          [5, "from-cache", "idx005-extract.json"],
          [6, "pending", undefined],
        ]
      );
      // The manifest row names a file, so the file has to be there and hold the
      // chapter's own extract — the row is a promise stage 4 later relies on.
      const written = JSON.parse(fs.readFileSync(checkpointPath(dir, 4), "utf-8"));
      assert.deepEqual(written.extraction, extractionOf("Henry Ashford"));
      assert.equal(written.meta.chapterIndex, 4);
      // The seam's normalised reason, not the vendor's own word for it, so the
      // field means the same thing in an OpenAI extract as in this one.
      assert.equal(written.meta.stopReason, "ok");
      // Only the extracted chapter costs anything, and only it is billed.
      assert.equal(requests.length, 1);
      assert.deepEqual(input.totals, { inputTokens: 1200, outputTokens: 340, apiCalls: 1 });
      // A cached chapter still feeds the roster, or later prompts would lose it.
      assert.deepEqual(input.roster.map((r) => r.name), ["Henry Ashford", "Mira"]);
    });
  });

  describe("rebuild mode", () => {
    test("makes no call and builds the roster a normal run over the same extracts builds", async () => {
      await withChunksDir(async (dir) => {
        seedExtract(dir, 4, "Henry Ashford");
        seedExtract(dir, 5, "Mira");
        const plans = planChapters(TWO_CHAPTERS, defaultOpts(), dir);

        // An empty script rather than no client at all: a client that throws on
        // any call makes "no API call" structural, instead of resting on the
        // plans happening not to ask for one.
        const rebuild = runInput({
          plans,
          chunksDir: dir,
          book: TWO_CHAPTERS,
          client: scriptedClient([]).client,
          rebuildMode: true,
        });
        await quiet(() => processChapters(rebuild));

        // Both extracts exist, so a normal run loads both from cache and never
        // reaches for a client either. The rebuilt roster must match it exactly
        // — that equivalence is the only thing making a rebuild trustworthy.
        const normal = runInput({ plans, chunksDir: dir, book: TWO_CHAPTERS, client: scriptedClient([]).client });
        await quiet(() => processChapters(normal));

        assert.deepEqual(rebuild.roster, normal.roster);
        assert.deepEqual(rebuild.manifestChapters, normal.manifestChapters);
        assert.deepEqual(rebuild.totals, { inputTokens: 0, outputTokens: 0, apiCalls: 0 });
      });
    });

    test("loads a forced index from cache instead of re-extracting it", async () => {
      await withChunksDir(async (dir) => {
        seedExtract(dir, 4, "Henry Ashford");
        // --force normally means "extract this one, period". A rebuild makes no
        // API call at all, so it must override even that; assertCheckpointModelsMatch
        // checks every cached extract in this mode for exactly that reason.
        const plans = planChapters(TWO_CHAPTERS, defaultOpts({ forceIndices: new Set([4]) }), dir);
        assert.equal(plans[0].willExtract, true);

        const { client, requests } = scriptedClient([]);
        const input = runInput({ plans, chunksDir: dir, book: TWO_CHAPTERS, client, rebuildMode: true });
        await quiet(() => processChapters(input));

        assert.equal(requests.length, 0);
        assert.equal(input.manifestChapters[0].status, "from-cache");
      });
    });
  });

  // --- the second provider -------------------------------------------------
  //
  // The walk hands the seam a resolved model and never learns which vendor
  // answered, so these ride an OpenAI-shaped double through exactly the code an
  // Anthropic run takes. What is being checked is that the provider on the
  // registry row picks the branch, and that everything downstream of the call —
  // the stamp, the roster fold, the manifest row — is indifferent to it.

  describe("an OpenAI model", () => {
    const ONE_CHAPTER = book([chapter(4, "One", 900)]);

    // Drive one OpenAI-served chapter through the walk, handing back the run
    // and what the vendor was asked, so each test below is its assertions and
    // nothing else.
    async function runOpenAIChapter(
      dir: string,
      canned: CannedOpenAIResponse
    ): Promise<{ input: ChapterRunInput; requests: CapturedOpenAIRequest[]; run: Promise<void> }> {
      const plans = planChapters(ONE_CHAPTER, defaultOpts(), dir);
      const { client, requests } = scriptedOpenAIClient([canned]);
      const input = runInput({ plans, chunksDir: dir, book: ONE_CHAPTER, client, model: LUNA_MODEL });
      return { input, requests, run: quiet(() => processChapters(input)) };
    }

    function writtenMetaAt(dir: string, index: number): { model?: unknown; modelReturned?: unknown; usage: Record<string, unknown> } {
      return JSON.parse(fs.readFileSync(checkpointPath(dir, index), "utf-8")).meta;
    }

    const OK = { text: JSON.stringify(extractionOf("Henry Ashford")) };

    test("reaches the OpenAI branch, and no Anthropic client is constructed", async () => {
      await withChunksDir(async (dir) => {
        const { requests, run } = await runOpenAIChapter(dir, OK);
        await run;

        // An Anthropic double would have been asked through `messages.create`;
        // this one was asked through `responses.create`, which is the whole
        // claim — the registry row's provider chose the branch.
        assert.equal(requests.length, 1);
        assert.equal(requests[0].model, "gpt-5.6-luna");
        // The roster-bearing prompt travels under OpenAI's parameter name.
        assert.match(String(requests[0].instructions), /extracting structured story data/);
      });
    });

    test("stamps the requested registry ID over the dated snapshot OpenAI serves", async () => {
      await withChunksDir(async (dir) => {
        await (await runOpenAIChapter(dir, OK)).run;

        // The reuse guard and the pricing table both look this up, and OpenAI's
        // served string is not a registry ID (ADR-0008).
        const meta = writtenMetaAt(dir, 4);
        assert.equal(meta.model, "gpt-5.6-luna");
        assert.equal(meta.modelReturned, OPENAI_SERVED_SNAPSHOT);
      });
    });

    test("records the reasoning split the same way an Anthropic run does", async () => {
      await withChunksDir(async (dir) => {
        const { input, run } = await runOpenAIChapter(dir, { ...OK, reasoningTokens: 704 });
        await run;

        // Same key an Anthropic extract carries — one concept under two vendor
        // names is what the seam exists to flatten. It decomposes the output
        // count rather than adding to it, so the billed totals are unmoved.
        const usage = writtenMetaAt(dir, 4).usage;
        assert.equal(usage.reasoning_tokens, 704);
        assert.equal(usage.output_tokens, 340);
        assert.deepEqual(input.totals, { inputTokens: 1200, outputTokens: 340, apiCalls: 1 });
      });
    });

    // A filtered response is not a truncated one: retrying it with a bigger
    // budget spends money on the same refusal, and dumping it as a partial
    // answer puts a non-extraction into the run.
    test("aborts on a content-filtered response as a refusal, not a truncation", async () => {
      await withChunksDir(async (dir) => {
        const { run } = await runOpenAIChapter(dir, {
          status: "incomplete",
          incompleteReason: "content_filter",
          text: null,
        });

        await assert.rejects(() => run, /refused/);
        assert.equal(fs.existsSync(checkpointPath(dir, 4)), false);
        assert.equal(fs.existsSync(checkpointPath(dir, 4).replace(/\.json$/, "-truncated.txt")), false);
      });
    });

    test("preserves truncated output before aborting, exactly as an Anthropic run does", async () => {
      await withChunksDir(async (dir) => {
        const { run } = await runOpenAIChapter(dir, {
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          text: '{"characters":[{"na',
        });

        await assert.rejects(() => run);

        const truncated = checkpointPath(dir, 4).replace(/\.json$/, "-truncated.txt");
        assert.equal(fs.readFileSync(truncated, "utf-8"), '{"characters":[{"na');
      });
    });

    // The vendor-specific half of the same rule the Anthropic table above pins:
    // a status the seam can only call "other" is not made usable by arriving
    // with a parseable body attached.
    test("aborts on a failed status even when it carried parseable text", async () => {
      await withChunksDir(async (dir) => {
        const { run } = await runOpenAIChapter(dir, { status: "failed", ...OK });

        await assert.rejects(() => run, /no usable text \(stop reason: other\)/);
        assert.equal(fs.existsSync(checkpointPath(dir, 4)), false);
      });
    });
  });
});
