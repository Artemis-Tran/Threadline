import { spawn } from "node:child_process";
import path from "node:path";
import { deriveOutputPath } from "./parse-epub";

// One-shot orchestrator: parse → extract → merge for a single EPUB, so a new
// book is one command instead of three hand-typed stages with intermediate
// output/{slug}-... paths. Each stage is spawned as its own subprocess (with
// inherited stdio) rather than imported, so every stage keeps its exact
// behavior — most importantly extract-book's interactive cost-confirmation
// prompt and per-chunk checkpointing. The chain stops on the first failure.

export interface RoutedArgs {
  epubPath: string;
  extractArgs: string[];
  mergeArgs: string[];
  dryRun: boolean;
}

// Flags that take a following value, grouped by the stage they belong to.
const EXTRACT_VALUE_FLAGS = new Set(["--from", "--to", "--skip"]);
const MERGE_VALUE_FLAGS = new Set(["--out", "--progression-order"]);
// Value-less extract flags.
const EXTRACT_BOOL_FLAGS = new Set(["--yes", "--rebuild-manifest"]);

const USAGE =
  "Usage: npm run book -- <path-to-epub> [--from N] [--to N] [--skip 11,28] " +
  "[--force [12,13]] [--rebuild-manifest] [--yes] [--dry-run] [--out <path>] " +
  "[--progression-order <path>]";

// Split the orchestrator's argv into the epub path plus per-stage flag lists.
// Kept pure (throws on bad input, no IO) so it's unit-testable. --dry-run is
// hoisted out: it means "parse + estimate extraction cost, then stop" (a fresh
// book has no chunks to merge yet), so it never reaches the merge stage.
export function routeArgs(argv: string[]): RoutedArgs {
  let epubPath: string | undefined;
  const extractArgs: string[] = [];
  const mergeArgs: string[] = [];
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      if (epubPath !== undefined) {
        throw new Error(`unexpected extra argument "${arg}" — only one EPUB path is allowed`);
      }
      epubPath = arg;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    // --force is the one flag with an optional value: a bare --force bypasses
    // the cache for all chunks, while --force 12,13 targets specific ones. Its
    // value is always a chapter-index list, so only consume the next token when
    // it looks like one — otherwise a bare --force before the epub path would
    // wrongly swallow the path.
    if (arg === "--force") {
      extractArgs.push("--force");
      const next = argv[i + 1];
      if (next !== undefined && /^[\d,]+$/.test(next)) {
        extractArgs.push(next);
        i++;
      }
      continue;
    }
    if (EXTRACT_BOOL_FLAGS.has(arg)) {
      extractArgs.push(arg);
      continue;
    }
    if (EXTRACT_VALUE_FLAGS.has(arg) || MERGE_VALUE_FLAGS.has(arg)) {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} expects a value`);
      }
      (EXTRACT_VALUE_FLAGS.has(arg) ? extractArgs : mergeArgs).push(arg, next);
      continue;
    }
    throw new Error(`unknown flag "${arg}"`);
  }

  if (epubPath === undefined) throw new Error(USAGE);
  return { epubPath, extractArgs, mergeArgs, dryRun };
}

// Run one stage script under the repo's local tsx, inheriting stdio so its
// output (and extract-book's confirmation prompt) reaches the terminal.
function runStage(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const child = spawn(tsxBin, [path.join(__dirname, script), ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code ?? "null"}`))
    );
  });
}

async function main() {
  let routed: RoutedArgs;
  try {
    routed = routeArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  // Same function parse-epub uses to name its output, so the path can't drift.
  const parsedPath = deriveOutputPath(routed.epubPath);

  console.log("\n[1/3] Parsing EPUB…");
  await runStage("parse-epub.ts", [routed.epubPath]);

  console.log(`\n[2/3] Extracting entities${routed.dryRun ? " (dry run)" : ""}…`);
  await runStage("extract-book.ts", [
    parsedPath,
    ...(routed.dryRun ? ["--dry-run"] : []),
    ...routed.extractArgs,
  ]);

  if (routed.dryRun) {
    console.log("\nDry run complete — parsed the book and estimated extraction cost. Re-run without --dry-run to extract and merge.");
    return;
  }

  console.log("\n[3/3] Merging thread…");
  await runStage("merge-thread.ts", [parsedPath, ...routed.mergeArgs]);

  console.log("\nDone. Import the output/*-thread.json into the web app with `npm run web`.");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
