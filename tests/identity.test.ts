import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isGenericAlias,
  sanitizeName,
  sanitizeAliases,
  identityOverlaps,
  findIdentityMatch,
  identifierSet,
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
});
