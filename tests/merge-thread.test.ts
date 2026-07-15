import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseArgs,
  extractTier,
  detectTierConflicts,
  extractProgressionValue,
  detectProgressionRegressions,
  loadProgressionOrders,
  DEFAULT_PROGRESSION_ORDERS,
  slugifyId,
  uniqueId,
  buildCharacters,
  buildRelationshipsAndEvents,
  buildThread,
  ChunkData,
} from "../src/merge-thread";
import {
  CharacterAppearance,
  CharacterRole,
  Extraction,
  ExtractedCharacter,
} from "../src/types";

// --- fixtures ------------------------------------------------------------

function character(
  name: string,
  overrides: Partial<ExtractedCharacter> = {}
): ExtractedCharacter {
  return { name, aliases: [], description: `${name} description`, role: "minor", ...overrides };
}

function chunk(chapterIndex: number, extraction: Partial<Extraction>): ChunkData {
  return {
    chapterIndex,
    chapterTitle: `Chapter ${chapterIndex}`,
    extraction: { characters: [], relationships: [], events: [], ...extraction },
  };
}

function appearance(chapterIndex: number, description: string): CharacterAppearance {
  return {
    chapterIndex,
    chapterTitle: null,
    name: "X",
    aliases: [],
    description,
    role: "minor" as CharacterRole,
  };
}

// --- parseArgs -----------------------------------------------------------

describe("parseArgs", () => {
  test("parses positional plus flags", () => {
    const opts = parseArgs(["book-parsed.json", "--dry-run", "--out", "custom.json"]);
    assert.deepEqual(opts, {
      parsedJsonPath: "book-parsed.json",
      dryRun: true,
      outPath: "custom.json",
      progressionOrderPath: null,
    });
  });

  test("throws usage error when positional is missing", () => {
    assert.throws(() => parseArgs([]), /Usage:/);
  });

  test("rejects unknown flags", () => {
    assert.throws(() => parseArgs(["book", "--frob"]), /Unknown flag: --frob/);
  });

  test("rejects a second positional", () => {
    assert.throws(() => parseArgs(["a", "b"]), /Unexpected argument: b/);
  });

  test("--out refuses to swallow a following flag", () => {
    assert.throws(() => parseArgs(["book", "--out", "--dry-run"]), /--out expects a file path/);
  });

  test("--out refuses a missing value", () => {
    assert.throws(() => parseArgs(["book", "--out"]), /--out expects a file path/);
  });

  test("parses --progression-order", () => {
    const opts = parseArgs(["book", "--progression-order", "orders.json"]);
    assert.equal(opts.progressionOrderPath, "orders.json");
  });

  test("--progression-order refuses to swallow a following flag", () => {
    assert.throws(() => parseArgs(["book", "--progression-order", "--dry-run"]), /--progression-order expects a file path/);
  });

  test("--progression-order refuses a missing value", () => {
    assert.throws(() => parseArgs(["book", "--progression-order"]), /--progression-order expects a file path/);
  });
});

// --- tier detection --------------------------------------------------------

describe("extractTier", () => {
  test("returns the first tier word, not the highest or last", () => {
    assert.equal(extractTier("Now a Red tier potter hoping to reach Orange tier soon"), "Red");
  });

  test("is case-insensitive", () => {
    assert.equal(extractTier("a YELLOW TIER merchant"), "Yellow");
  });

  test("requires the literal 'tier' suffix", () => {
    assert.equal(extractTier("wore a red cloak"), null);
  });

  test("returns null when no tier is stated", () => {
    assert.equal(extractTier("a cheerful dock worker"), null);
  });
});

describe("detectTierConflicts", () => {
  test("no conflicts when every appearance agrees (the Davos Merrick case)", () => {
    const conflicts = detectTierConflicts([
      appearance(31, "A Yellow tier Advanced Merchant"),
      appearance(38, "The Yellow tier Advanced Merchant returns"),
      appearance(50, "A Yellow tier Advanced Merchant who runs a trade company"),
    ]);
    assert.deepEqual(conflicts, []);
  });

  test("no conflicts on a genuine ascending progression", () => {
    const conflicts = detectTierConflicts([
      appearance(4, "a Red tier potter"),
      appearance(20, "an Orange tier potter"),
      appearance(44, "a Yellow tier potter"),
    ]);
    assert.deepEqual(conflicts, []);
  });

  test("flags a pairwise-adjacent regression with both data points", () => {
    const conflicts = detectTierConflicts([
      appearance(33, "a Yellow tier patron"),
      appearance(48, "recognizing her Orange tier potential"),
      appearance(50, "a Green tier patron"),
    ]);
    assert.deepEqual(conflicts, [
      {
        from: { chapterIndex: 33, value: "Yellow" },
        to: { chapterIndex: 48, value: "Orange" },
      },
    ]);
  });

  test("appearances without a stated tier are excluded from the timeline", () => {
    const conflicts = detectTierConflicts([
      appearance(31, "a Yellow tier merchant"),
      appearance(32, "referenced in passing"), // no tier — must not break adjacency
      appearance(38, "the Yellow tier merchant"),
    ]);
    assert.deepEqual(conflicts, []);
  });

  test("fewer than two tier-bearing appearances can never conflict", () => {
    assert.deepEqual(detectTierConflicts([appearance(4, "a Red tier potter")]), []);
    assert.deepEqual(detectTierConflicts([]), []);
  });
});

// --- generic progression-order engine ---------------------------------------

const CLASS_RANK = {
  key: "Class Rank",
  order: ["E", "D", "C", "B", "A", "S"],
  descriptionPattern: "{value}-rank",
};

describe("extractProgressionValue", () => {
  test("DEFAULT_PROGRESSION_ORDERS' Tier entry reproduces extractTier's exact behavior", () => {
    assert.equal(
      extractProgressionValue("Now a Red tier potter hoping to reach Orange tier soon", DEFAULT_PROGRESSION_ORDERS[0]),
      "Red"
    );
    assert.equal(extractProgressionValue("wore a red cloak", DEFAULT_PROGRESSION_ORDERS[0]), null);
  });

  test("works against a non-Tier vocabulary the code has no special knowledge of", () => {
    assert.equal(extractProgressionValue("An S-rank adventurer walked in", CLASS_RANK), "S");
    assert.equal(extractProgressionValue("a C-rank blacksmith", CLASS_RANK), "C");
  });

  test("is case-insensitive and returns null on no match", () => {
    assert.equal(extractProgressionValue("an a-rank mercenary", CLASS_RANK), "A");
    assert.equal(extractProgressionValue("a cheerful dock worker", CLASS_RANK), null);
  });
});

describe("detectProgressionRegressions", () => {
  test("no regression on a genuine ascending progression for a non-Tier key", () => {
    const regressions = detectProgressionRegressions(
      [appearance(4, "an E-rank adventurer"), appearance(20, "a C-rank adventurer"), appearance(44, "an A-rank adventurer")],
      [CLASS_RANK]
    );
    assert.deepEqual(regressions, []);
  });

  test("flags an adjacent-decrease regression, tagged with the key", () => {
    const regressions = detectProgressionRegressions(
      [appearance(10, "a B-rank mercenary"), appearance(25, "a D-rank mercenary")],
      [CLASS_RANK]
    );
    assert.deepEqual(regressions, [
      { key: "Class Rank", from: { chapterIndex: 10, value: "B" }, to: { chapterIndex: 25, value: "D" } },
    ]);
  });

  test("checks every configured key independently — a regression on one axis doesn't affect the other", () => {
    const appearances = [
      appearance(4, "a Yellow tier, E-rank potter"),
      appearance(30, "a Red tier, S-rank potter"), // Tier regresses (Yellow->Red); Class Rank ascends (E->S)
    ];
    const regressions = detectProgressionRegressions(appearances, [DEFAULT_PROGRESSION_ORDERS[0], CLASS_RANK]);
    assert.deepEqual(regressions, [
      { key: "Tier", from: { chapterIndex: 4, value: "Yellow" }, to: { chapterIndex: 30, value: "Red" } },
    ]);
  });

  test("detectTierConflicts equals detectProgressionRegressions filtered to the Tier key, minus the key field", () => {
    const appearances = [
      appearance(33, "a Yellow tier patron"),
      appearance(48, "recognizing her Orange tier potential"),
      appearance(50, "a Green tier patron"),
    ];
    const generic = detectProgressionRegressions(appearances, [DEFAULT_PROGRESSION_ORDERS[0]]);
    const legacy = detectTierConflicts(appearances);
    assert.deepEqual(
      generic.map((r) => ({ from: r.from, to: r.to })),
      legacy
    );
  });
});

describe("loadProgressionOrders", () => {
  test("with no config path, returns exactly the built-in defaults", () => {
    assert.deepEqual(loadProgressionOrders(), DEFAULT_PROGRESSION_ORDERS);
    assert.deepEqual(loadProgressionOrders(null), DEFAULT_PROGRESSION_ORDERS);
  });

  function withTempConfig(content: string, fn: (p: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-progorder-"));
    const p = path.join(dir, "progression-order.json");
    try {
      fs.writeFileSync(p, content);
      fn(p);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a config file adds a new key alongside the defaults", () => {
    withTempConfig(JSON.stringify({ "Class Rank": { order: ["E", "D", "C", "B", "A", "S"], descriptionPattern: "{value}-rank" } }), (p) => {
      const orders = loadProgressionOrders(p);
      assert.equal(orders.length, 2);
      assert.deepEqual(
        orders.find((o) => o.key === "Class Rank"),
        CLASS_RANK
      );
      assert.deepEqual(
        orders.find((o) => o.key === "Tier"),
        DEFAULT_PROGRESSION_ORDERS[0]
      );
    });
  });

  test("a config file can override the built-in Tier entry", () => {
    withTempConfig(JSON.stringify({ Tier: { order: ["Bronze", "Silver", "Gold"] } }), (p) => {
      const orders = loadProgressionOrders(p);
      assert.equal(orders.length, 1);
      assert.deepEqual(orders[0].order, ["Bronze", "Silver", "Gold"]);
      // descriptionPattern falls back to a generated default when omitted
      assert.equal(orders[0].descriptionPattern, "{value}\\s+Tier\\b");
    });
  });

  test("a config key overrides the default case-insensitively (no duplicate axis)", () => {
    withTempConfig(JSON.stringify({ tier: { order: ["Bronze", "Silver", "Gold"] } }), (p) => {
      const orders = loadProgressionOrders(p);
      assert.equal(orders.length, 1, "a lowercase 'tier' key must replace the default, not sit alongside it");
      assert.equal(orders[0].key, "tier");
      assert.deepEqual(orders[0].order, ["Bronze", "Silver", "Gold"]);
    });
  });

  test("missing config file produces a named, actionable error", () => {
    assert.throws(() => loadProgressionOrders("/nonexistent/orders.json"), /--progression-order file not found/);
  });

  test("malformed JSON produces a named, actionable error", () => {
    withTempConfig("{ not json", (p) => {
      assert.throws(() => loadProgressionOrders(p), /not valid JSON/);
    });
  });

  test("an entry missing a valid order array produces a named, actionable error", () => {
    withTempConfig(JSON.stringify({ "Class Rank": { order: "not-an-array" } }), (p) => {
      assert.throws(() => loadProgressionOrders(p), /"Class Rank".*non-empty "order" array/s);
    });
  });

  test("a descriptionPattern missing the {value} placeholder produces a named, actionable error", () => {
    withTempConfig(JSON.stringify({ Level: { order: ["1", "2"], descriptionPattern: "level" } }), (p) => {
      assert.throws(() => loadProgressionOrders(p), /"Level".*\{value\}.*placeholder/s);
    });
  });
});

describe("extractProgressionValue — regex-unsafe order values", () => {
  test("a value containing a regex metacharacter is matched literally, not as a quantifier", () => {
    const order = { key: "Rank", order: ["A+", "B"], descriptionPattern: "{value}-rank" };
    assert.equal(extractProgressionValue("an A+-rank adventurer", order), "A+");
    // Without escaping, unescaped "+" would make this also match plain "A-rank" as if "A+"
    // meant "one or more A's" — it must not.
    assert.equal(extractProgressionValue("an A-rank adventurer", order), null);
  });

  test("a value containing an unbalanced paren does not throw", () => {
    const order = { key: "Rank", order: ["(broken"], descriptionPattern: "{value}\\s+tier\\b" };
    assert.doesNotThrow(() => extractProgressionValue("a (broken tier", order));
  });

  test("a descriptionPattern missing {value} returns null instead of throwing on m[1]", () => {
    const order = { key: "Level", order: ["1", "2"], descriptionPattern: "level" };
    assert.equal(extractProgressionValue("the level system", order), null);
  });
});

// --- id generation ---------------------------------------------------------

describe("slugifyId / uniqueId", () => {
  test("slugifies to lowercase kebab-case", () => {
    assert.equal(slugifyId("Davos Merrick"), "davos-merrick");
    assert.equal(slugifyId("  Lady  Celeste! "), "lady-celeste");
  });

  test("falls back to 'character' for all-symbol names", () => {
    assert.equal(slugifyId("???"), "character");
  });

  test("uniqueId suffixes on collision", () => {
    const used = new Set(["thomas", "thomas-2"]);
    assert.equal(uniqueId("thomas", used), "thomas-3");
    assert.equal(uniqueId("henry", used), "henry");
  });
});

// --- character merge --------------------------------------------------------

describe("buildCharacters", () => {
  test("recency-first description: the most recent chapter wins even when shorter", () => {
    const { characters } = buildCharacters([
      chunk(4, { characters: [character("Henry", { description: "a long and detailed early description of Henry" })] }),
      chunk(50, { characters: [character("Henry", { description: "short late one" })] }),
    ]);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].description, "short late one");
    assert.equal(characters[0].appearances.length, 2);
  });

  test("longest name becomes canonical; the demoted name survives as an alias", () => {
    const { characters, nameToId } = buildCharacters([
      chunk(4, { characters: [character("Henry")] }),
      chunk(35, { characters: [character("Henry Ashford", { aliases: ["Henry"] })] }),
    ]);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].name, "Henry Ashford");
    assert.deepEqual(characters[0].aliases, ["Henry"]);
    // both identifiers resolve to the same id
    assert.equal(nameToId.get("henry"), characters[0].id);
    assert.equal(nameToId.get("henry ashford"), characters[0].id);
  });

  test("old canonical name is kept when promotion arrives via a shared alias", () => {
    const { characters } = buildCharacters([
      chunk(25, { characters: [character("carriage driver")] }),
      chunk(41, {
        characters: [character("older man participant", { aliases: ["carriage driver"] })],
      }),
    ]);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].name, "older man participant");
    assert.ok(
      characters[0].aliases.some((a) => a.toLowerCase() === "carriage driver"),
      "demoted name must remain reachable as an alias"
    );
  });

  test("unification: records split by the greedy pass merge once identifiers overlap", () => {
    // ch4 creates "Henry"; ch35's "Henry Ashford" shares no identifier yet, so
    // the greedy pass splits it into a second record; ch40 gives "Henry" the
    // alias "Mystic Potter", which ch35's record also holds — the unification
    // pass must fold them into one character.
    const { characters, nameToId } = buildCharacters([
      chunk(4, { characters: [character("Henry")] }),
      chunk(35, { characters: [character("Henry Ashford", { aliases: ["Mystic Potter"] })] }),
      chunk(40, { characters: [character("Henry", { aliases: ["Mystic Potter"] })] }),
    ]);
    assert.equal(characters.length, 1);
    const henry = characters[0];
    assert.equal(henry.appearances.length, 3);
    assert.deepEqual(
      henry.appearances.map((a) => a.chapterIndex),
      [4, 35, 40]
    );
    assert.equal(henry.firstAppearedChapterIndex, 4);
    assert.equal(henry.lastAppearedChapterIndex, 40);
    for (const ident of ["henry", "henry ashford", "mystic potter"]) {
      assert.equal(nameToId.get(ident), henry.id, ident);
    }
  });

  test("nameToId is consistent with grouping: every appearance name resolves to its owner", () => {
    // The lord-brennan regression: a later chunk's alias must not rebind an
    // identifier to a different character than the one holding the appearance.
    const { characters, nameToId } = buildCharacters([
      chunk(4, { characters: [character("Master Brennan", { aliases: ["Brennan"] })] }),
      chunk(11, { characters: [character("Lord Brennan")] }),
      chunk(29, { characters: [character("Lord Brennan", { aliases: ["Brennan"] })] }),
    ]);
    for (const c of characters) {
      for (const a of c.appearances) {
        assert.equal(
          nameToId.get(a.name.toLowerCase()),
          c.id,
          `appearance "${a.name}" of ${c.id} must resolve to its own character`
        );
      }
    }
    // no two characters may share an identifier
    const owners = new Map<string, string>();
    for (const c of characters) {
      for (const ident of [c.name, ...c.aliases].map((s) => s.toLowerCase())) {
        assert.ok(!owners.has(ident) || owners.get(ident) === c.id, `shared identifier: ${ident}`);
        owners.set(ident, c.id);
      }
    }
  });

  test("distinct characters with disjoint identifiers stay separate", () => {
    const { characters } = buildCharacters([
      chunk(4, { characters: [character("Henry"), character("Davos Merrick", { aliases: ["Merrick"] })] }),
    ]);
    assert.equal(characters.length, 2);
  });

  test("documented limitation: two different people sharing a bare name over-merge", () => {
    const { characters } = buildCharacters([
      chunk(5, { characters: [character("Thomas", { description: "twin farmer's son" })] }),
      chunk(6, { characters: [character("Thomas", { description: "elderly man with a cane" })] }),
    ]);
    // This asserts the KNOWN over-merge behavior (deferred to a future
    // disambiguation pass) so a change to it is a deliberate decision, not an
    // accident.
    assert.equal(characters.length, 1);
    assert.equal(characters[0].appearances.length, 2);
  });

  test("tier conflicts are computed on the final, unified appearance history", () => {
    const { characters } = buildCharacters([
      chunk(10, { characters: [character("Celeste", { description: "a Yellow tier patron" })] }),
      chunk(20, { characters: [character("Celeste", { description: "an Orange tier patron" })] }),
    ]);
    assert.deepEqual(characters[0].conflicts, [
      { from: { chapterIndex: 10, value: "Yellow" }, to: { chapterIndex: 20, value: "Orange" } },
    ]);
  });

  test("an explicit tierOrder parameter overrides the built-in default for conflicts", () => {
    const goldToBronze = { key: "Tier", order: ["Bronze", "Silver", "Gold"], descriptionPattern: "{value}\\s+tier\\b" };
    const { characters } = buildCharacters(
      [
        chunk(10, { characters: [character("Hero", { description: "a Gold tier hero" })] }),
        chunk(20, { characters: [character("Hero", { description: "a Bronze tier hero" })] }),
      ],
      goldToBronze
    );
    // Under the default TIER_ORDER vocabulary neither word matches at all, so
    // this only produces a conflict if the override parameter actually took effect.
    assert.deepEqual(characters[0].conflicts, [
      { from: { chapterIndex: 10, value: "Gold" }, to: { chapterIndex: 20, value: "Bronze" } },
    ]);
  });

  test("omitting tierOrder still matches detectTierConflicts' built-in default behavior", () => {
    const { characters } = buildCharacters([
      chunk(10, { characters: [character("Celeste", { description: "a Yellow tier patron" })] }),
      chunk(20, { characters: [character("Celeste", { description: "an Orange tier patron" })] }),
    ]);
    assert.deepEqual(characters[0].conflicts, detectTierConflicts(characters[0].appearances));
  });

  test("characters with empty names after sanitizing are skipped", () => {
    const { characters } = buildCharacters([
      chunk(4, { characters: [character("(the guard)"), character("Henry")] }),
    ]);
    assert.equal(characters.length, 1);
    assert.equal(characters[0].name, "Henry");
  });
});

// --- relationships and events ------------------------------------------------

describe("buildRelationshipsAndEvents", () => {
  function setup(chunks: ChunkData[]) {
    const warnings: string[] = [];
    const { characters, nameToId } = buildCharacters(chunks);
    const { relationships, events } = buildRelationshipsAndEvents(chunks, nameToId, warnings);
    return { characters, relationships, events, warnings };
  }

  test("direction flips bucket together; each statement keeps its stated direction", () => {
    const chunks = [
      chunk(4, {
        characters: [character("Henry"), character("Baron Ashford")],
        relationships: [{ from: "Henry", to: "Baron Ashford", type: "father-son", description: "d1" }],
      }),
      chunk(11, {
        characters: [character("Henry"), character("Baron Ashford")],
        relationships: [{ from: "Baron Ashford", to: "Henry", type: "parent-child", description: "d2" }],
      }),
    ];
    const { relationships } = setup(chunks);
    assert.equal(relationships.length, 1);
    const rel = relationships[0];
    assert.equal(rel.history.length, 2);
    assert.equal(rel.history[0].fromId, "henry");
    assert.equal(rel.history[1].fromId, "baron-ashford");
    // current is the most recent chapter's statement, direction as stated
    assert.equal(rel.current.chapterIndex, 11);
    assert.equal(rel.current.fromId, "baron-ashford");
    assert.deepEqual([...rel.participantIds].sort(), ["baron-ashford", "henry"]);
  });

  test("names resolve against the global index, not just the chunk's own characters", () => {
    const chunks = [
      chunk(4, { characters: [character("Baron Ashford")] }),
      chunk(9, {
        characters: [character("Henry")],
        relationships: [{ from: "Henry", to: "Baron Ashford", type: "family", description: "d" }],
      }),
    ];
    const { relationships, warnings } = setup(chunks);
    assert.equal(relationships.length, 1);
    assert.deepEqual(warnings, []);
  });

  test("unresolvable relationship names produce a warning and drop the statement", () => {
    const chunks = [
      chunk(9, {
        characters: [character("Henry")],
        relationships: [{ from: "Henry", to: "Potter's Need", type: "ownership", description: "d" }],
      }),
    ];
    const { relationships, warnings } = setup(chunks);
    assert.equal(relationships.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ch9/);
    assert.match(warnings[0], /Potter's Need/);
  });

  test("self-referential relationships (via aliasing) are dropped with a warning", () => {
    const chunks = [
      chunk(31, {
        characters: [character("Davos Merrick", { aliases: ["Merrick"] })],
        relationships: [{ from: "Merrick", to: "Davos Merrick", type: "self", description: "d" }],
      }),
    ];
    const { relationships, warnings } = setup(chunks);
    assert.equal(relationships.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /self-referential/);
  });

  test("events flatten in chapter order with resolved ids; unresolved participants get null", () => {
    const chunks = [
      chunk(4, {
        characters: [character("Henry")],
        events: [
          { summary: "e1", characters_involved: ["Henry", "The System"], significance: "major" as const },
        ],
      }),
      chunk(5, {
        characters: [character("Henry")],
        events: [{ summary: "e2", characters_involved: ["Henry"], significance: "minor" as const }],
      }),
    ];
    const { events, warnings } = setup(chunks);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.chapterIndex),
      [4, 5]
    );
    assert.deepEqual(events[0].charactersInvolved, [
      { id: "henry", name: "Henry" },
      { id: null, name: "The System" },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /The System/);
  });
});

// --- buildThread end-to-end against a synthetic on-disk fixture ---------------

describe("buildThread", () => {
  function writeFixture(opts: {
    complete?: boolean;
    corruptChunk?: boolean;
    dropChunkFile?: boolean;
  } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-test-"));
    const extraction: Extraction = {
      characters: [
        { name: "Henry", aliases: ["Mystic Potter"], description: "a Red tier potter", role: "pov" },
        { name: "Davos Merrick", aliases: ["Merrick"], description: "a Yellow tier merchant", role: "minor" },
      ],
      relationships: [
        { from: "Davos Merrick", to: "Henry", type: "adversarial", description: "predatory offer" },
      ],
      events: [{ summary: "an offer is made", characters_involved: ["Henry", "Davos Merrick"], significance: "major" }],
    };
    const manifest = {
      meta: { bookTitle: "Test Book", complete: opts.complete ?? true },
      chapters: [
        { index: 0, title: "Front matter", wordCount: 10, status: "skipped:word-count" },
        { index: 4, title: "Chapter 1", wordCount: 1500, status: "from-cache", file: "idx004-extract.json" },
      ],
      roster: [],
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    if (!opts.dropChunkFile) {
      fs.writeFileSync(
        path.join(dir, "idx004-extract.json"),
        opts.corruptChunk ? "{ not json" : JSON.stringify({ meta: {}, extraction })
      );
    }
    return dir;
  }

  test("produces a complete thread from a synthetic chunks dir", () => {
    const dir = writeFixture();
    try {
      const thread = buildThread(dir, "test-book");
      assert.equal(thread.meta.bookTitle, "Test Book");
      assert.equal(thread.meta.chapterCount, 1); // the skipped chapter has no file
      assert.equal(thread.meta.characterCount, 2);
      assert.equal(thread.meta.relationshipCount, 1);
      assert.equal(thread.meta.eventCount, 1);
      assert.equal(thread.meta.conflictCount, 0);
      assert.equal(thread.meta.progressionRegressionCount, 0);
      assert.deepEqual(thread.progressionRegressions, []);
      assert.equal(thread.meta.warningCount, 0);
      assert.equal(thread.meta.slug, "test-book");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("progression regressions for a non-Tier configured key surface separately from conflicts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-test-"));
    try {
      const manifest = {
        meta: { bookTitle: "Test Book", complete: true },
        chapters: [
          { index: 4, title: "Chapter 1", wordCount: 1500, status: "from-cache", file: "idx004-extract.json" },
          { index: 5, title: "Chapter 2", wordCount: 1500, status: "from-cache", file: "idx005-extract.json" },
        ],
        roster: [],
      };
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      fs.writeFileSync(
        path.join(dir, "idx004-extract.json"),
        JSON.stringify({
          meta: {},
          extraction: {
            characters: [{ name: "Henry", aliases: [], description: "a B-rank potter", role: "pov" }],
            relationships: [],
            events: [],
          },
        })
      );
      fs.writeFileSync(
        path.join(dir, "idx005-extract.json"),
        JSON.stringify({
          meta: {},
          extraction: {
            characters: [{ name: "Henry", aliases: [], description: "a D-rank potter", role: "pov" }],
            relationships: [],
            events: [],
          },
        })
      );
      const configPath = path.join(dir, "progression-order.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ "Class Rank": { order: ["E", "D", "C", "B", "A", "S"], descriptionPattern: "{value}-rank" } })
      );

      const thread = buildThread(dir, "test-book", configPath);
      assert.equal(thread.meta.progressionRegressionCount, 1);
      assert.deepEqual(thread.progressionRegressions, [
        {
          key: "Class Rank",
          from: { chapterIndex: 4, value: "B" },
          to: { chapterIndex: 5, value: "D" },
          characterId: "henry",
          characterName: "Henry",
        },
      ]);
      // The non-Tier regression must not leak into the Tier-only conflicts bucket.
      assert.deepEqual(thread.conflicts, []);
      assert.equal(thread.meta.conflictCount, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a --progression-order override of the Tier key actually reaches conflicts, end to end", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-test-"));
    try {
      const manifest = {
        meta: { bookTitle: "Test Book", complete: true },
        chapters: [
          { index: 4, title: "Chapter 1", wordCount: 1500, status: "from-cache", file: "idx004-extract.json" },
          { index: 5, title: "Chapter 2", wordCount: 1500, status: "from-cache", file: "idx005-extract.json" },
        ],
        roster: [],
      };
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      // "Gold" then "Bronze" is NOT a regression under the default TIER_ORDER
      // vocabulary (neither word matches it at all) — it only becomes a
      // detectable regression if the Tier override below actually takes effect.
      fs.writeFileSync(
        path.join(dir, "idx004-extract.json"),
        JSON.stringify({
          meta: {},
          extraction: {
            characters: [{ name: "Hero", aliases: [], description: "a Gold tier hero", role: "pov" }],
            relationships: [],
            events: [],
          },
        })
      );
      fs.writeFileSync(
        path.join(dir, "idx005-extract.json"),
        JSON.stringify({
          meta: {},
          extraction: {
            characters: [{ name: "Hero", aliases: [], description: "a Bronze tier hero", role: "pov" }],
            relationships: [],
            events: [],
          },
        })
      );
      const configPath = path.join(dir, "tier-override.json");
      fs.writeFileSync(configPath, JSON.stringify({ Tier: { order: ["Bronze", "Silver", "Gold"] } }));

      const thread = buildThread(dir, "test-book", configPath);
      assert.deepEqual(thread.conflicts, [
        {
          from: { chapterIndex: 4, value: "Gold" },
          to: { chapterIndex: 5, value: "Bronze" },
          characterId: "hero",
          characterName: "Hero",
        },
      ]);
      assert.equal(thread.meta.conflictCount, 1);
      // The overridden Tier key must not also show up as a second, separate axis.
      assert.deepEqual(thread.progressionRegressions, []);
      assert.equal(thread.meta.progressionRegressionCount, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an incomplete manifest", () => {
    const dir = writeFixture({ complete: false });
    try {
      assert.throws(() => buildThread(dir, "test-book"), /not complete/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails loud when a manifest-listed chunk file is missing", () => {
    const dir = writeFixture({ dropChunkFile: true });
    try {
      assert.throws(() => buildThread(dir, "test-book"), /idx004-extract\.json.*does not exist/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names the offending file on corrupt chunk JSON", () => {
    const dir = writeFixture({ corruptChunk: true });
    try {
      assert.throws(() => buildThread(dir, "test-book"), /idx004-extract\.json.*not valid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a missing manifest with a pointer to extract-book.ts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-test-"));
    try {
      assert.throws(() => buildThread(dir, "test-book"), /No manifest found.*extract-book/s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
