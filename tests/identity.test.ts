import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isGenericAlias,
  sanitizeName,
  sanitizeAliases,
  identityOverlaps,
  findIdentityMatch,
  identifierSet,
  tokenize,
  collectNonIdentifyingKeys,
} from "../src/identity";

describe("sanitizeName", () => {
  test("strips parenthetical disambiguation", () => {
    assert.equal(sanitizeName("Marcus (blacksmith's apprentice)"), "Marcus");
  });

  test("leaves plain names untouched", () => {
    assert.equal(sanitizeName("Henry Ashford"), "Henry Ashford");
  });

  test("trims whitespace left by the paren cut", () => {
    assert.equal(sanitizeName("  Elise  (his sister)"), "Elise");
  });

  test("returns empty string for a pure parenthetical", () => {
    assert.equal(sanitizeName("(the guard)"), "");
  });
});

describe("isGenericAlias", () => {
  test("rejects pronouns", () => {
    for (const alias of ["he", "She", "him", "THEM", "it"]) {
      assert.equal(isGenericAlias(alias), true, alias);
    }
  });

  test("rejects possessive-relational phrases", () => {
    for (const alias of ["his brother", "our son", "her father", "my apprentice"]) {
      assert.equal(isGenericAlias(alias), true, alias);
    }
  });

  test("rejects lowercase 'the X' role titles", () => {
    for (const alias of ["the guard", "the captain", "the merchant"]) {
      assert.equal(isGenericAlias(alias), true, alias);
    }
  });

  test("accepts capitalized 'the X' epithets", () => {
    for (const alias of ["the Reaper", "the Mystic Potter"]) {
      assert.equal(isGenericAlias(alias), false, alias);
    }
  });

  test("accepts ordinary names", () => {
    assert.equal(isGenericAlias("Merrick"), false);
  });
});

describe("sanitizeAliases", () => {
  test("drops generic, empty, over-long, and duplicate aliases", () => {
    const result = sanitizeAliases("Henry", [
      "him",                                        // generic
      "Henry",                                      // duplicate of name
      "HENRY",                                      // case-insensitive duplicate of name
      "Mystic Potter",
      "mystic potter",                              // case-insensitive duplicate of earlier alias
      "",                                           // empty
      "x".repeat(41),                               // over-long
      "the potter",                                 // lowercase role title
    ]);
    assert.deepEqual(result, ["Mystic Potter"]);
  });

  test("sanitizes parentheticals inside aliases", () => {
    assert.deepEqual(sanitizeAliases("Henry", ["Ashford (the younger)"]), ["Ashford"]);
  });
});

describe("identityOverlaps / findIdentityMatch", () => {
  const henry = { name: "Henry", aliases: ["Mystic Potter"] };

  test("matches on bare name, case-insensitively", () => {
    assert.equal(identityOverlaps({ name: "henry", aliases: [] }, henry), true);
  });

  test("matches candidate name against known alias", () => {
    assert.equal(identityOverlaps({ name: "Mystic Potter", aliases: [] }, henry), true);
  });

  test("matches candidate alias against known name", () => {
    assert.equal(identityOverlaps({ name: "Henry Ashford", aliases: ["Henry"] }, henry), true);
  });

  test("no overlap means no match", () => {
    assert.equal(identityOverlaps({ name: "Davos Merrick", aliases: ["Merrick"] }, henry), false);
  });

  test("findIdentityMatch returns the first match in pool order", () => {
    const pool = [
      { name: "Master Brennan", aliases: ["Brennan"] },
      { name: "Lord Brennan", aliases: [] },
    ];
    // "Brennan" overlaps both entries' identifier sets via the first's alias —
    // pool order decides, documenting the greedy first-match semantics.
    const match = findIdentityMatch({ name: "Brennan", aliases: [] }, pool);
    assert.equal(match, pool[0]);
  });

  test("identifierSet lowercases name and aliases", () => {
    assert.deepEqual([...identifierSet(henry)].sort(), ["henry", "mystic potter"]);
  });

  test("identifierSet excludes non-identifying aliases but always keeps the name", () => {
    const nonId = new Set(["the izcalli", "yaotl cuatzo"]);
    const rec = { name: "Yaotl Cuatzo", aliases: ["the Izcalli", "Leopard Man"] };
    // "yaotl cuatzo" is in the set but it's this record's NAME → still kept;
    // "the izcalli" is a bridging alias → dropped; "leopard man" survives.
    assert.deepEqual([...identifierSet(rec, nonId)].sort(), ["leopard man", "yaotl cuatzo"]);
  });

  test("identityOverlaps ignores a non-identifying-only overlap", () => {
    const nonId = new Set(["the izcalli"]);
    assert.equal(
      identityOverlaps(
        { name: "Yaotl Cuatzo", aliases: ["the Izcalli"] },
        { name: "Tupoc Xical", aliases: ["the Izcalli"] },
        nonId
      ),
      false
    );
  });

  test("identityOverlaps still matches on a genuine shared alias", () => {
    assert.equal(
      identityOverlaps(
        { name: "Henry", aliases: ["Mystic Potter"] },
        { name: "Henry Ashford", aliases: ["Mystic Potter"] },
        new Set(["the izcalli"])
      ),
      true
    );
  });

  test("identityOverlaps still matches on a name even when that string is non-identifying", () => {
    // The genuine "Ju" character matches on its own name; only the stray "Ju"
    // *alias* on Lan's record is demoted.
    assert.equal(
      identityOverlaps({ name: "Ju", aliases: [] }, { name: "Ju", aliases: [] }, new Set(["ju"])),
      true
    );
    assert.equal(
      identityOverlaps({ name: "Lan", aliases: ["Ju"] }, { name: "Ju", aliases: [] }, new Set(["ju"])),
      false
    );
  });
});

describe("tokenize", () => {
  test("splits on non-alphanumeric separators and lowercases", () => {
    assert.deepEqual(tokenize("Lady Isabel Ruesta"), ["lady", "isabel", "ruesta"]);
    assert.deepEqual(tokenize("Marcus-Aurelius (the elder)"), ["marcus", "aurelius", "the", "elder"]);
  });

  test("composed and decomposed accented names tokenize identically", () => {
    const composed = "Jos\u00E9"; // e-acute as one code point U+00E9
    const decomposed = "Jose\u0301"; // e + combining acute accent U+0301
    assert.notEqual(composed, decomposed); // genuinely different byte sequences
    assert.deepEqual(tokenize(composed), tokenize(decomposed));
    assert.deepEqual(tokenize(composed), ["jos\u00E9"]);
  });
});

describe("collectNonIdentifyingKeys", () => {
  test("flags a shared epithet spanning token-disjoint people", () => {
    const set = collectNonIdentifyingKeys([
      { name: "Yaotl Cuatzo", aliases: ["the Izcalli"] },
      { name: "Tupoc Xical", aliases: ["the Izcalli"] },
      { name: "Yaretzi", aliases: ["the Izcalli"] },
    ]);
    assert.ok(set.has("the izcalli"));
  });

  test("flags an alias that collides with a different person's real name", () => {
    // "Ju" is a genuine name on one record and a stray alias on Lan's.
    const set = collectNonIdentifyingKeys([
      { name: "Lan", aliases: ["Ju"] },
      { name: "Ju", aliases: [] },
    ]);
    assert.ok(set.has("ju"));
  });

  test("flags a shared epithet despite a shared honorific token", () => {
    // Both owners carry "lady"; without excluding honorifics from clustering
    // they would look like one person and "infanzona" would stay matchable.
    const set = collectNonIdentifyingKeys([
      { name: "Lady Isabel Ruesta", aliases: ["infanzona"] },
      { name: "Lady Ferranda Villazur", aliases: ["infanzona"] },
    ]);
    assert.ok(set.has("infanzona"));
  });

  test("does NOT flag an alias shared by token-related names", () => {
    // "Henry" and "Henry Ashford" share the identifying token "henry", so
    // "Mystic Potter" links one person — it must stay a matching key.
    const set = collectNonIdentifyingKeys([
      { name: "Henry", aliases: ["Mystic Potter"] },
      { name: "Henry Ashford", aliases: ["Mystic Potter"] },
    ]);
    assert.equal(set.has("mystic potter"), false);
  });

  test("does NOT flag a unique epithet held by a single person", () => {
    const set = collectNonIdentifyingKeys([
      { name: "Grimm", aliases: ["the Reaper"] },
      { name: "Grimm", aliases: ["the Reaper"] },
    ]);
    assert.equal(set.has("the reaper"), false);
  });
});
