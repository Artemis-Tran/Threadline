import * as fs from "fs";
import * as path from "path";
import { sanitizeName } from "./identity";
import { resolveModel } from "./models";

// A/B comparison for stage-3 extraction: given two chunk directories produced
// by extract-book (e.g. a Sonnet baseline and a Haiku candidate), report how
// their per-chapter and roster-level output differs, plus the cost each run
// paid. The point is to answer "is the cheaper model good enough?" against a
// real book without eyeballing 47 JSON files by hand.
//
// Name matching is normalized-exact (case-insensitive, parenthetical stripped
// via identity.sanitizeName) — it is NOT alias-aware, so a character one model
// records as "Davos" and the other as "Davos Merrick" shows up as one-only-in-
// each. Treat the roster diff as a lead to inspect, not a verdict.

export interface ChunkExtraction {
  characters: { name: string }[];
  relationships: unknown[];
  events: unknown[];
}

export interface LoadedRun {
  label: string;
  dir: string;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chunks: Map<number, ChunkExtraction>; // keyed by chapter index
}

export interface RunSummary {
  label: string;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chapters: number;
  characters: number;
  relationships: number;
  events: number;
  rosterSize: number;
}

export interface ChapterDelta {
  index: number;
  aChars: number;
  bChars: number;
  aRels: number;
  bRels: number;
  aEvents: number;
  bEvents: number;
  onlyA: string[]; // character display names in A not B (this chapter)
  onlyB: string[];
}

export interface ComparisonReport {
  a: RunSummary;
  b: RunSummary;
  sharedIndices: number[];
  onlyInADir: number[]; // chapter indices present only in A's dir
  onlyInBDir: number[];
  perChapter: ChapterDelta[]; // for shared indices, in index order
  rosterOnlyA: string[]; // roster display names in A not B (across all chunks)
  rosterOnlyB: string[];
}

const CHUNK_RE = /^idx(\d+)-extract\.json$/;

function normKey(name: string): string {
  return sanitizeName(name).toLowerCase();
}

// Map normalized key -> first-seen display name, over a set of characters.
function nameMap(chars: { name: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of chars) {
    const key = normKey(c.name);
    if (key && !m.has(key)) m.set(key, sanitizeName(c.name));
  }
  return m;
}

interface ManifestInfo {
  model: string | null;
  // When a *complete* manifest lists chapter files, restrict loading to exactly
  // those — so a stale/orphaned idxNNN checkpoint left in the dir can't skew the
  // comparison. Null when there's no complete manifest (fall back to scanning).
  allowedFiles: Set<string> | null;
  partial: boolean;
}

function readManifest(dir: string): ManifestInfo {
  const partial = fs.existsSync(path.join(dir, "manifest.partial.json"));
  // A partial marker means an incomplete run wrote checkpoints after the last
  // complete manifest — so that manifest.json (its model, its file list) is
  // stale. Don't trust it: infer the model from the chunks and scan all files.
  if (partial) return { model: null, allowedFiles: null, partial: true };
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { model: null, allowedFiles: null, partial };
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const model = typeof m?.meta?.model === "string" ? m.meta.model : null;
    const complete = m?.meta?.complete === true;
    let allowedFiles: Set<string> | null = null;
    if (complete && Array.isArray(m.chapters)) {
      allowedFiles = new Set(
        m.chapters.map((c: { file?: unknown }) => c.file).filter((f: unknown): f is string => typeof f === "string")
      );
    }
    return { model, allowedFiles, partial };
  } catch {
    console.warn(`Warning: ${manifestPath} is not valid JSON — scanning all chunk files.`);
    return { model: null, allowedFiles: null, partial };
  }
}

// Price summed tokens at a model's registry rates. Null when the model is
// unknown/unpriced (or "mixed"), so cost never silently reports as $0.
function priceTokens(model: string | null, inputTokens: number, outputTokens: number): number | null {
  if (!model) return null;
  try {
    const rates = resolveModel(model).rates;
    return Math.round((inputTokens * rates.inputUsdPerMTok + outputTokens * rates.outputUsdPerMTok) / 1e4) / 100;
  } catch {
    return null;
  }
}

// Read a chunks dir into a LoadedRun. Cost is computed from the per-chunk usage
// stamped in each checkpoint (not the manifest's actualCostUsd, which only
// reflects the last invocation's freshly-extracted chapters) — so a resumed or
// rebuilt-from-cache run still gets an accurate total. Chunk files that don't
// parse are skipped with a warning.
export function loadRun(dir: string, label: string): LoadedRun {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Chunks dir not found: ${resolved}`);
  }

  const manifest = readManifest(resolved);
  if (manifest.partial) {
    console.warn(`Warning: ${label} has a manifest.partial.json — that run was incomplete; counts/cost may be partial.`);
  }

  const chunks = new Map<number, ChunkExtraction>();
  const chunkModels = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;

  for (const file of fs.readdirSync(resolved)) {
    const match = CHUNK_RE.exec(file);
    if (!match) continue;
    if (manifest.allowedFiles && !manifest.allowedFiles.has(file)) continue; // orphaned/stale checkpoint
    const index = Number(match[1]);
    let parsed: { extraction?: Record<string, unknown>; meta?: Record<string, unknown> };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(resolved, file), "utf-8"));
    } catch {
      console.warn(`Warning: ${file} is not valid JSON — skipped.`);
      continue;
    }
    const e = parsed.extraction ?? {};
    chunks.set(index, {
      characters: Array.isArray(e.characters) ? (e.characters as { name: string }[]) : [],
      relationships: Array.isArray(e.relationships) ? e.relationships : [],
      events: Array.isArray(e.events) ? e.events : [],
    });
    const meta = parsed.meta ?? {};
    if (typeof meta.model === "string") chunkModels.add(meta.model);
    const u = meta.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
      inputTokens += u.input_tokens;
      outputTokens += u.output_tokens;
      sawUsage = true;
    }
  }

  // Prefer the manifest's model; else infer from the chunks (flag disagreement).
  const model =
    manifest.model ?? (chunkModels.size === 1 ? [...chunkModels][0] : chunkModels.size > 1 ? "mixed" : null);

  return {
    label,
    dir: resolved,
    model,
    costUsd: sawUsage ? priceTokens(model, inputTokens, outputTokens) : null,
    inputTokens: sawUsage ? inputTokens : null,
    outputTokens: sawUsage ? outputTokens : null,
    chunks,
  };
}

// Roster is passed in (built once by the caller) so it isn't recomputed here
// and again for the cross-run diff.
function summarize(run: LoadedRun, roster: Map<string, string>): RunSummary {
  let characters = 0;
  let relationships = 0;
  let events = 0;
  for (const chunk of run.chunks.values()) {
    characters += chunk.characters.length;
    relationships += chunk.relationships.length;
    events += chunk.events.length;
  }
  return {
    label: run.label,
    model: run.model,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    chapters: run.chunks.size,
    characters,
    relationships,
    events,
    rosterSize: roster.size,
  };
}

function rosterMap(run: LoadedRun): Map<string, string> {
  const roster = new Map<string, string>();
  for (const chunk of run.chunks.values()) {
    for (const [key, display] of nameMap(chunk.characters)) {
      if (!roster.has(key)) roster.set(key, display);
    }
  }
  return roster;
}

// Pure comparison — no IO, so it can be unit-tested with synthetic runs.
export function compareRuns(a: LoadedRun, b: LoadedRun): ComparisonReport {
  const aIdx = [...a.chunks.keys()];
  const bIdx = new Set(b.chunks.keys());
  const shared = aIdx.filter((i) => bIdx.has(i)).sort((x, y) => x - y);
  const onlyInADir = aIdx.filter((i) => !bIdx.has(i)).sort((x, y) => x - y);
  const onlyInBDir = [...b.chunks.keys()].filter((i) => !a.chunks.has(i)).sort((x, y) => x - y);

  const perChapter: ChapterDelta[] = shared.map((index) => {
    const ca = a.chunks.get(index)!;
    const cb = b.chunks.get(index)!;
    const mapA = nameMap(ca.characters);
    const mapB = nameMap(cb.characters);
    const onlyA = [...mapA].filter(([k]) => !mapB.has(k)).map(([, d]) => d);
    const onlyB = [...mapB].filter(([k]) => !mapA.has(k)).map(([, d]) => d);
    return {
      index,
      aChars: ca.characters.length,
      bChars: cb.characters.length,
      aRels: ca.relationships.length,
      bRels: cb.relationships.length,
      aEvents: ca.events.length,
      bEvents: cb.events.length,
      onlyA,
      onlyB,
    };
  });

  const rosterA = rosterMap(a);
  const rosterB = rosterMap(b);
  const rosterOnlyA = [...rosterA].filter(([k]) => !rosterB.has(k)).map(([, d]) => d).sort();
  const rosterOnlyB = [...rosterB].filter(([k]) => !rosterA.has(k)).map(([, d]) => d).sort();

  return {
    a: summarize(a, rosterA),
    b: summarize(b, rosterB),
    sharedIndices: shared,
    onlyInADir,
    onlyInBDir,
    perChapter,
    rosterOnlyA,
    rosterOnlyB,
  };
}

function fmtCost(run: RunSummary): string {
  if (run.costUsd === null) {
    if (run.model === "mixed") return "n/a (mixed models in dir)";
    return "n/a (no per-chunk usage / unpriced model)";
  }
  return `$${run.costUsd.toFixed(2)}`;
}

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function printReport(report: ComparisonReport, limit: number): void {
  const { a, b } = report;
  console.log("");
  console.log(`A (baseline):  ${a.label} — model ${a.model ?? "?"} — cost ${fmtCost(a)}`);
  console.log(`B (candidate): ${b.label} — model ${b.model ?? "?"} — cost ${fmtCost(b)}`);
  console.log("");

  console.log("Aggregate (A → B, Δ = B − A)");
  console.log("-------------------------------------------");
  const row = (label: string, av: number, bv: number) =>
    console.log(`${label.padEnd(16)} ${String(av).padStart(6)} → ${String(bv).padStart(6)}  (${signed(bv - av)})`);
  row("Chapters", a.chapters, b.chapters);
  row("Characters", a.characters, b.characters);
  row("Relationships", a.relationships, b.relationships);
  row("Events", a.events, b.events);
  row("Roster (unique)", a.rosterSize, b.rosterSize);
  console.log("");

  if (report.onlyInADir.length || report.onlyInBDir.length) {
    console.log(`Chapters only in A: ${report.onlyInADir.join(", ") || "none"}`);
    console.log(`Chapters only in B: ${report.onlyInBDir.join(", ") || "none"}`);
    console.log("");
  }

  console.log("Per-chapter counts (chars / rels / events)");
  console.log("idx  |  A c/r/e        |  B c/r/e        | Δchars");
  console.log("-----+-----------------+-----------------+-------");
  for (const d of report.perChapter) {
    const aCol = `${d.aChars}/${d.aRels}/${d.aEvents}`.padEnd(15);
    const bCol = `${d.bChars}/${d.bRels}/${d.bEvents}`.padEnd(15);
    const flag = d.bChars < d.aChars ? " ⚠" : "";
    console.log(`${String(d.index).padStart(4)} | ${aCol} | ${bCol} | ${signed(d.bChars - d.aChars).padStart(5)}${flag}`);
  }
  console.log("");

  const showList = (title: string, names: string[]) => {
    console.log(`${title} (${names.length})`);
    if (names.length === 0) {
      console.log("  none");
    } else {
      console.log("  " + names.slice(0, limit).join(", ") + (names.length > limit ? `, … (+${names.length - limit} more)` : ""));
    }
  };
  showList("Characters in A but not B (candidate may have missed/renamed)", report.rosterOnlyA);
  showList("Characters in B but not A (candidate added/renamed)", report.rosterOnlyB);
  console.log("");
  console.log("Note: name matching is normalized-exact, not alias-aware — roster-only");
  console.log("entries are often the same character named differently. Inspect before judging.");
}

export interface CompareCliArgs {
  dirA: string;
  dirB: string;
  labelA: string;
  labelB: string;
  limit: number;
}

const COMPARE_USAGE =
  "Usage: tsx src/compare-extractions.ts <baseline-chunks-dir> <candidate-chunks-dir> [--label-a NAME] [--label-b NAME] [--limit N]";

// Strict parser: each flag's value is consumed only if present and not itself a
// flag, --limit must be a positive integer, and unknown flags / extra positionals
// are rejected rather than silently ignored.
export function parseCompareArgs(argv: string[]): CompareCliArgs {
  let labelA = "A";
  let labelB = "B";
  let limit = 25;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label-a" || arg === "--label-b") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} expects a value`);
      if (arg === "--label-a") labelA = value;
      else labelB = value;
    } else if (arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--limit expects a value");
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit expects a positive integer");
      limit = n;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 2) throw new Error(COMPARE_USAGE);
  return { dirA: positionals[0], dirB: positionals[1], labelA, labelB, limit };
}

function main(): void {
  let args: CompareCliArgs;
  try {
    args = parseCompareArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const report = compareRuns(loadRun(args.dirA, args.labelA), loadRun(args.dirB, args.labelB));
  printReport(report, args.limit);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
