import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compareRuns,
  loadRun,
  parseCompareArgs,
  LoadedRun,
  ChunkExtraction,
} from "../src/compare-extractions";

function chunk(names: string[], rels = 0, events = 0): ChunkExtraction {
  return {
    characters: names.map((name) => ({ name })),
    relationships: Array.from({ length: rels }, () => ({})),
    events: Array.from({ length: events }, () => ({})),
  };
}

function run(label: string, chunks: Record<number, ChunkExtraction>, overrides: Partial<LoadedRun> = {}): LoadedRun {
  return {
    label,
    dir: `/fake/${label}`,
    model: label,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    chunks: new Map(Object.entries(chunks).map(([k, v]) => [Number(k), v])),
    ...overrides,
  };
}

describe("compareRuns", () => {
  test("summarizes counts and unique roster per run", () => {
    const a = run("sonnet", { 0: chunk(["Alice", "Bob"], 1, 2), 1: chunk(["Alice", "Cara"], 0, 1) });
    const b = run("haiku", { 0: chunk(["Alice"], 1, 1), 1: chunk(["Alice"], 0, 1) });
    const r = compareRuns(a, b);

    assert.equal(r.a.characters, 4); // 2 + 2 raw
    assert.equal(r.a.rosterSize, 3); // Alice, Bob, Cara
    assert.equal(r.b.characters, 2);
    assert.equal(r.b.rosterSize, 1); // Alice
    assert.deepEqual(r.sharedIndices, [0, 1]);
  });

  test("normalizes names (case + parenthetical) when diffing rosters", () => {
    const a = run("sonnet", { 0: chunk(["Davos Merrick (the potter)"]) });
    const b = run("haiku", { 0: chunk(["davos merrick"]) });
    const r = compareRuns(a, b);
    assert.deepEqual(r.rosterOnlyA, []); // same character after normalization
    assert.deepEqual(r.rosterOnlyB, []);
    assert.deepEqual(r.perChapter[0].onlyA, []);
  });

  test("reports roster names each run has that the other lacks", () => {
    const a = run("sonnet", { 0: chunk(["Alice", "Bob"]) });
    const b = run("haiku", { 0: chunk(["Alice", "Zed"]) });
    const r = compareRuns(a, b);
    assert.deepEqual(r.rosterOnlyA, ["Bob"]);
    assert.deepEqual(r.rosterOnlyB, ["Zed"]);
  });

  test("tracks chapters present in only one run", () => {
    const a = run("sonnet", { 0: chunk(["Alice"]), 2: chunk(["Bob"]) });
    const b = run("haiku", { 0: chunk(["Alice"]), 5: chunk(["Cara"]) });
    const r = compareRuns(a, b);
    assert.deepEqual(r.sharedIndices, [0]);
    assert.deepEqual(r.onlyInADir, [2]);
    assert.deepEqual(r.onlyInBDir, [5]);
  });
});

describe("parseCompareArgs", () => {
  test("requires two dir positionals and defaults labels/limit", () => {
    const a = parseCompareArgs(["dirA", "dirB"]);
    assert.deepEqual([a.dirA, a.dirB, a.labelA, a.labelB, a.limit], ["dirA", "dirB", "A", "B", 25]);
  });

  test("parses labels and a positive integer limit", () => {
    const a = parseCompareArgs(["dirA", "dirB", "--label-a", "sonnet", "--label-b", "haiku", "--limit", "5"]);
    assert.equal(a.labelA, "sonnet");
    assert.equal(a.labelB, "haiku");
    assert.equal(a.limit, 5);
  });

  test("rejects malformed input instead of silently defaulting", () => {
    assert.throws(() => parseCompareArgs(["dirA"]), /Usage:/);
    assert.throws(() => parseCompareArgs(["a", "b", "c"]), /Usage:/);
    assert.throws(() => parseCompareArgs(["a", "b", "--nope"]), /Unknown flag/);
    assert.throws(() => parseCompareArgs(["a", "b", "--label-a", "--limit", "5"]), /--label-a expects a value/);
    assert.throws(() => parseCompareArgs(["a", "b", "--limit", "0"]), /positive integer/);
    assert.throws(() => parseCompareArgs(["a", "b", "--limit", "-3"]), /positive integer/);
    assert.throws(() => parseCompareArgs(["a", "b", "--limit", "abc"]), /positive integer/);
    assert.throws(() => parseCompareArgs(["a", "b", "--limit"]), /--limit expects a value/);
  });
});

describe("loadRun", () => {
  function writeChunk(dir: string, index: number, model: string, inTok: number, outTok: number): void {
    const name = `idx${String(index).padStart(3, "0")}-extract.json`;
    const body = {
      meta: { model, usage: { input_tokens: inTok, output_tokens: outTok } },
      extraction: { characters: [{ name: "Alice" }], relationships: [], events: [] },
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  }

  test("prices from summed per-chunk usage and honors a complete manifest's file list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-cmp-"));
    try {
      writeChunk(dir, 0, "claude-haiku-4-5", 500_000, 500_000);
      writeChunk(dir, 1, "claude-haiku-4-5", 500_000, 500_000);
      // Orphan checkpoint not listed in a complete manifest — must be excluded.
      writeChunk(dir, 2, "claude-haiku-4-5", 999_999, 999_999);
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          meta: { model: "claude-haiku-4-5", complete: true },
          chapters: [
            { index: 0, file: "idx000-extract.json", status: "extracted" },
            { index: 1, file: "idx001-extract.json", status: "extracted" },
          ],
        })
      );

      const runData = loadRun(dir, "haiku");
      assert.equal(runData.model, "claude-haiku-4-5");
      assert.equal(runData.chunks.size, 2); // orphan idx002 excluded
      assert.equal(runData.inputTokens, 1_000_000);
      assert.equal(runData.outputTokens, 1_000_000);
      // Haiku $1/$5 per MTok: 1*1 + 1*5 = $6
      assert.equal(runData.costUsd, 6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distrusts a stale complete manifest when a partial marker is present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadline-cmp-"));
    try {
      // Chunks are Haiku, but a stale complete manifest claims Sonnet and lists
      // only idx000. The partial marker must force chunk-inferred model + full scan.
      writeChunk(dir, 0, "claude-haiku-4-5", 500_000, 500_000);
      writeChunk(dir, 1, "claude-haiku-4-5", 500_000, 500_000);
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          meta: { model: "claude-sonnet-5", complete: true },
          chapters: [{ index: 0, file: "idx000-extract.json", status: "extracted" }],
        })
      );
      fs.writeFileSync(path.join(dir, "manifest.partial.json"), "{}");

      const runData = loadRun(dir, "haiku");
      assert.equal(runData.model, "claude-haiku-4-5"); // inferred from chunks, not stale manifest
      assert.equal(runData.chunks.size, 2); // stale allowedFiles ignored — idx001 included
      assert.equal(runData.costUsd, 6); // priced at Haiku, not Sonnet
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
