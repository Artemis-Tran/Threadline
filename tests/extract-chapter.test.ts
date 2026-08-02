import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { probeArgs, probeDir } from "../src/extract-chapter";

// The single-chapter probe is a translator: it maps a chapter index onto the
// whole-book command's flags and spawns it. Only the translation is testable
// here, and that is deliberate — the spawn itself is stdio inheritance and an
// exit code, while everything the flags then cause (the cost gate, the schema,
// the extract writer) is covered where the whole-book command is covered.

const PARSED = "output/the-potters-path-parsed.json";

// Every probe forwards the same window/force/model trio; only the tail varies.
function expectedFor(index: string, model = "claude-sonnet-5", tail: string[] = []): string[] {
  return [
    PARSED,
    "--from", index,
    "--to", index,
    "--force", index,
    "--model", model,
    "--out-dir", probeDir(PARSED, model),
    ...tail,
  ];
}

describe("probeArgs", () => {
  test("maps a chapter index onto a single-chapter window, forced, at the default model", () => {
    assert.deepEqual(probeArgs([PARSED, "8"]), expectedFor("8"));
  });

  test("fences the window to the probed chapter so no other chapter is extracted", () => {
    // --force alone would leave every other narrative chapter without a cached
    // extract eligible, i.e. a whole paid book run from a one-chapter command.
    const args = probeArgs([PARSED, "8"]);
    assert.deepEqual(args.slice(args.indexOf("--from"), args.indexOf("--from") + 4), [
      "--from", "8", "--to", "8",
    ]);
  });

  test("forces re-extraction, so a repeat probe re-runs rather than reporting nothing to do", () => {
    assert.ok(probeArgs([PARSED, "8"]).includes("--force"));
  });

  test("never auto-confirms, so the cost gate is the guard against paying twice", () => {
    assert.equal(probeArgs([PARSED, "8"]).includes("--yes"), false);
  });

  test("writes into a probe directory keyed by model, never a book's run directory", () => {
    const sonnet = probeArgs([PARSED, "8"]);
    const haiku = probeArgs([PARSED, "8", "--model", "haiku"]);
    const dirOf = (args: string[]) => args[args.indexOf("--out-dir") + 1];
    assert.notEqual(dirOf(sonnet), dirOf(haiku));
    assert.match(path.basename(dirOf(sonnet)), /^the-potters-path-probe-claude-sonnet-5$/);
    assert.match(path.basename(dirOf(haiku)), /^the-potters-path-probe-claude-haiku-4-5$/);
    // The real run directory for this book, which a probe must never touch.
    assert.notEqual(path.basename(dirOf(sonnet)), "the-potters-path-chunks");
  });

  test("resolves --model to a registry ID and forwards it", () => {
    assert.deepEqual(probeArgs([PARSED, "8", "--model", "haiku"]), expectedFor("8", "claude-haiku-4-5"));
    assert.deepEqual(probeArgs([PARSED, "--model", "luna", "8"]), expectedFor("8", "gpt-5.6-luna"));
  });

  test("forwards --roster unchanged", () => {
    assert.deepEqual(
      probeArgs([PARSED, "8", "--roster", "probe-roster.json"]),
      expectedFor("8", "claude-sonnet-5", ["--roster", "probe-roster.json"])
    );
  });

  test("--list forwards the free listing and nothing else", () => {
    // No model, no out-dir, no force: the listing makes no API call, and
    // forwarding a probe's flags would only invent a directory for it.
    assert.deepEqual(probeArgs([PARSED, "--list"]), [PARSED, "--list"]);
    assert.deepEqual(probeArgs([PARSED, "--list", "--model", "haiku"]), [PARSED, "--list"]);
  });

  test("rejects a misspelled flag instead of silently running the default model", () => {
    assert.throws(() => probeArgs([PARSED, "8", "--modle", "haiku"]), /Unknown flag: --modle/);
  });

  test("rejects unknown models and valueless flags before anything is spawned", () => {
    // gpt-5.6-sol is a real model the registry deliberately omits, so this also
    // pins the allowlist as an allowlist rather than a vendor-prefix check.
    assert.throws(() => probeArgs([PARSED, "8", "--model", "gpt-5.6-sol"]), /Unknown model/);
    assert.throws(() => probeArgs([PARSED, "8", "--model"]), /--model expects/);
    assert.throws(() => probeArgs([PARSED, "8", "--roster"]), /--roster expects/);
    assert.throws(() => probeArgs([PARSED, "8", "--roster", "--model", "haiku"]), /--roster expects/);
  });

  test("rejects wrong argument counts and a non-numeric chapter", () => {
    assert.throws(() => probeArgs([PARSED]), /Usage:/);
    assert.throws(() => probeArgs([PARSED, "8", "9"]), /Usage:/);
    assert.throws(() => probeArgs([PARSED, "eight"]), /must be a non-negative integer/);
    assert.throws(() => probeArgs([PARSED, "-1"]), /must be a non-negative integer/);
  });
});

describe("probeDir", () => {
  test("is absolute, under output/, and keyed by both book and model", () => {
    const dir = probeDir(PARSED, "claude-sonnet-5");
    assert.equal(path.isAbsolute(dir), true);
    assert.equal(dir, path.resolve(__dirname, "..", "output", "the-potters-path-probe-claude-sonnet-5"));
  });

  test("does not depend on the caller's working directory", () => {
    assert.equal(probeDir(PARSED, "claude-sonnet-5"), probeDir(path.resolve(PARSED), "claude-sonnet-5"));
  });
});
