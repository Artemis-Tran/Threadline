import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, parseChapterArgs } from "../src/extract-chapter";

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

describe("extract-chapter parseChapterArgs", () => {
  test("parses positionals and defaults to Sonnet", () => {
    const args = parseChapterArgs(["book.json", "8"]);
    assert.equal(args.parsedJsonPath, "book.json");
    assert.equal(args.chapterArg, "8");
    assert.equal(args.model, "claude-sonnet-5");
  });

  test("resolves --model anywhere on the line without shifting positionals", () => {
    const args = parseChapterArgs(["book.json", "--model", "haiku", "8"]);
    assert.equal(args.parsedJsonPath, "book.json");
    assert.equal(args.chapterArg, "8");
    assert.equal(args.model, "claude-haiku-4-5");
  });

  test("treats --list as the chapter positional", () => {
    assert.equal(parseChapterArgs(["book.json", "--list"]).chapterArg, "--list");
  });

  test("rejects a misspelled flag instead of silently running the default model", () => {
    // The whole point of the guard: --modle must not reach the paid API path.
    assert.throws(() => parseChapterArgs(["book.json", "8", "--modle", "haiku"]), /Unknown flag: --modle/);
  });

  test("resolves the OpenAI shorthands", () => {
    assert.equal(parseChapterArgs(["book.json", "8", "--model", "luna"]).model, "gpt-5.6-luna");
    assert.equal(parseChapterArgs(["book.json", "8", "--model", "terra"]).model, "gpt-5.6-terra");
  });

  test("rejects unknown models, a valueless --model, and wrong arg counts", () => {
    // gpt-5.6-sol is a real model the registry deliberately omits, so this also
    // pins the allowlist as an allowlist rather than a vendor-prefix check.
    assert.throws(() => parseChapterArgs(["book.json", "8", "--model", "gpt-5.6-sol"]), /Unknown model/);
    assert.throws(() => parseChapterArgs(["book.json", "8", "--model"]), /--model expects/);
    assert.throws(() => parseChapterArgs(["book.json"]), /Usage:/);
    assert.throws(() => parseChapterArgs(["book.json", "8", "9"]), /Usage:/);
  });
});
