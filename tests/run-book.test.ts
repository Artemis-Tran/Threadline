import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { routeArgs } from "../src/run-book";

describe("routeArgs", () => {
  test("bare epub path — no stage flags", () => {
    const r = routeArgs(["input/book.epub"]);
    assert.equal(r.epubPath, "input/book.epub");
    assert.deepEqual(r.extractArgs, []);
    assert.deepEqual(r.mergeArgs, []);
    assert.equal(r.dryRun, false);
  });

  test("routes each flag to the stage it belongs to", () => {
    const r = routeArgs([
      "book.epub",
      "--from", "5",
      "--to", "10",
      "--skip", "11,28",
      "--yes",
      "--rebuild-manifest",
      "--out", "out/custom.json",
      "--progression-order", "cfg.json",
    ]);
    assert.deepEqual(r.extractArgs, [
      "--from", "5",
      "--to", "10",
      "--skip", "11,28",
      "--yes",
      "--rebuild-manifest",
    ]);
    assert.deepEqual(r.mergeArgs, ["--out", "out/custom.json", "--progression-order", "cfg.json"]);
  });

  test("--force with a value goes to extract", () => {
    const r = routeArgs(["book.epub", "--force", "12,13"]);
    assert.deepEqual(r.extractArgs, ["--force", "12,13"]);
  });

  test("bare --force (no value) is passed through without consuming the epub", () => {
    // --force followed by the positional path must not swallow the path.
    const r = routeArgs(["--force", "book.epub"]);
    assert.equal(r.epubPath, "book.epub");
    assert.deepEqual(r.extractArgs, ["--force"]);
  });

  test("--dry-run is hoisted out, not forwarded to a stage list", () => {
    const r = routeArgs(["book.epub", "--dry-run"]);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.extractArgs, []);
    assert.deepEqual(r.mergeArgs, []);
  });

  test("flag order relative to the epub path doesn't matter", () => {
    const r = routeArgs(["--to", "3", "book.epub", "--yes"]);
    assert.equal(r.epubPath, "book.epub");
    assert.deepEqual(r.extractArgs, ["--to", "3", "--yes"]);
  });

  test("rejects a missing epub path", () => {
    assert.throws(() => routeArgs([]), /Usage/);
    assert.throws(() => routeArgs(["--yes"]), /Usage/);
  });

  test("rejects a second positional argument", () => {
    assert.throws(() => routeArgs(["a.epub", "b.epub"]), /only one EPUB path/);
  });

  test("rejects an unknown flag", () => {
    assert.throws(() => routeArgs(["book.epub", "--nope"]), /unknown flag/);
  });

  test("rejects a value flag with no value", () => {
    assert.throws(() => routeArgs(["book.epub", "--from"]), /--from expects a value/);
    assert.throws(() => routeArgs(["book.epub", "--out", "--yes"]), /--out expects a value/);
  });
});
