import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSmoothScrollPreference } from "../src/lib/smoothScrollPreference";

test("smooth scrolling defaults on and only an explicit off disables it", () => {
  assert.equal(parseSmoothScrollPreference(null), true);
  assert.equal(parseSmoothScrollPreference("on"), true);
  assert.equal(parseSmoothScrollPreference("garbage"), true);
  assert.equal(parseSmoothScrollPreference("off"), false);
});
