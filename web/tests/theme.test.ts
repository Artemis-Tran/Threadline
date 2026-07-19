import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTheme, parsePreference, resolveTheme } from "../src/lib/theme";

test("parsePreference accepts the two explicit themes", () => {
  assert.equal(parsePreference("light"), "light");
  assert.equal(parsePreference("dark"), "dark");
});

test("parsePreference falls back to system for anything else", () => {
  assert.equal(parsePreference(null), "system");
  assert.equal(parsePreference(""), "system");
  assert.equal(parsePreference("system"), "system");
  assert.equal(parsePreference("DARK"), "system");
  assert.equal(parsePreference("garbage"), "system");
});

test("nextTheme flips between light and dark", () => {
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "light");
});

test("resolveTheme follows the OS only in system mode", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("dark", false), "dark");
});
