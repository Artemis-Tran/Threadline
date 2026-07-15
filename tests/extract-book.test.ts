import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseArgs,
  planChapters,
  planStatus,
  estimateCostUsd,
  costUsd,
  checkpointPath,
  indexFromCheckpoint,
  readCheckpointCharacters,
  updateRoster,
  buildSystemPrompt,
  CliOptions,
} from "../src/extract-book";
import { ParsedBook, ParsedChapter, RosterEntry, ExtractedCharacter } from "../src/types";

// --- fixtures ------------------------------------------------------------

function defaultOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    parsedJsonPath: "book-parsed.json",
    from: null,
    to: null,
    skip: new Set(),
    dryRun: false,
    forceAll: false,
    forceIndices: new Set(),
    yes: false,
    rebuildManifest: false,
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
});

// --- cost math -------------------------------------------------------------

describe("costUsd / estimateCostUsd", () => {
  test("costUsd applies $3/$15 per MTok, rounded to cents", () => {
    assert.equal(costUsd(1_000_000, 0), 3);
    assert.equal(costUsd(0, 1_000_000), 15);
    assert.equal(costUsd(1000, 1000), 0.02); // $0.018 rounds to 2 cents
    assert.equal(costUsd(0, 0), 0);
  });

  test("estimateCostUsd counts only willExtract chapters", () => {
    const plans = planChapters(
      book([chapter(0, "Chapter 1", 1000), chapter(1, "Chapter 2", 1000)]),
      defaultOpts({ skip: new Set([1]) }),
      "/nonexistent-chunks-dir"
    );
    // one chapter: (1000*2.7 + 1200) tokens in, 2000 out
    const expected = (3900 * 3 + 2000 * 15) / 1e6;
    assert.ok(Math.abs(estimateCostUsd(plans) - expected) < 1e-9);
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
});
