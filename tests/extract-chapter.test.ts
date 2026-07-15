import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/extract-chapter";

// Stage 2 is a single-chapter probe script; everything beyond the prompt
// builder lives inside main() and calls the API, so only the prompt contract
// is pinned here.
describe("extract-chapter buildSystemPrompt", () => {
  test("embeds the book title", () => {
    const prompt = buildSystemPrompt("The Potter's Path");
    assert.match(prompt, /"The Potter's Path"/);
  });

  test("falls back to Unknown for a missing title", () => {
    assert.match(buildSystemPrompt(null), /"Unknown"/);
  });

  test("constrains extraction to the chapter itself", () => {
    const prompt = buildSystemPrompt("X");
    assert.match(prompt, /only what this chapter itself states/);
    assert.match(prompt, /do not use outside knowledge/);
  });
});
