import { spawn } from "node:child_process";
import * as path from "path";
import { deriveSlug } from "./types";
import { DEFAULT_MODEL, resolveModel } from "./models";

// Single-chapter probe: extract one chapter and eyeball the result before
// paying for a book. It is a translator, not a second extraction path — it maps
// a chapter index onto a one-chapter extraction window and spawns extract-book,
// which owns the schema, the prompt, the roster, the cost gate, and the extract
// writer. Spawning (rather than importing) is the same choice run-book makes,
// for the same reason: it preserves the spawned command's exact behaviour, most
// importantly its interactive cost-confirmation prompt.
//
// This command used to have its own copies of all of the above. They differed
// from extract-book's in ways that stopped being intentional once the closed
// vocabularies for character role and event significance shipped, at which
// point its output was no longer a chapter extract as the glossary defines one.

const USAGE =
  "Usage: tsx src/extract-chapter.ts <parsed-json-path> <chapter-index|--list> [--model <id>] [--roster <path>]";

// Where a probe's chapter extract and manifest land. Keyed by extraction model
// so probing a second model cannot overwrite the first result, and separate
// from the book's real run directory (output/{slug}-chunks) so a probe can
// neither pollute a run nor trip its model-reuse guard. ADR-0008 already
// establishes directories, not filenames, as how runs are kept apart.
//
// Resolved against the repo rather than the caller's cwd, exactly as
// parse-epub's output path is, so `npm run extract` names the same directory
// from anywhere.
export function probeDir(parsedJsonPath: string, model: string): string {
  return path.resolve(__dirname, "..", "output", `${deriveSlug(parsedJsonPath)}-probe-${model}`);
}

// Translate this command's arguments into extract-book's. Pure so the forwarded
// flags are verifiable without spawning anything, and so a typo — a misspelled
// flag, an unknown model — is rejected here rather than reaching a paid call
// with the default model.
//
// Note what is deliberately absent: --yes. A probe goes through the same cost
// confirmation a book run does. --force is deliberately present: a probe that
// silently reported "nothing to extract" on a repeat run would be confusing,
// and the gate is what stops the repeat from silently re-charging.
export function probeArgs(argv: string[]): string[] {
  let model = DEFAULT_MODEL;
  let rosterPath: string | null = null;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Error("--model expects a model name");
      model = resolveModel(value).id;
    } else if (arg === "--roster") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--roster expects a path");
      rosterPath = value;
    } else if (arg === "--list") {
      // An allowed positional, not a flag: it stands where a chapter index would.
      positionals.push(arg);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 2) throw new Error(USAGE);
  const [parsedJsonPath, chapterArg] = positionals;

  // The array index is NOT the book's chapter number (front matter and POV
  // interludes are interleaved), so the listing has to stay reachable — and
  // free. It makes no API call, so it forwards no probe flags: no model, no
  // directory to key by it, nothing to charge for.
  if (chapterArg === "--list") return [parsedJsonPath, "--list"];

  if (!/^\d+$/.test(chapterArg)) {
    throw new Error(`Chapter index must be a non-negative integer or --list, got: ${chapterArg}`);
  }

  return [
    parsedJsonPath,
    // --from/--to fence the run to this one chapter. Without them, every other
    // narrative chapter with no cached extract would still be eligible, and a
    // one-chapter command would quote a whole book. --force then overrides that
    // window for the probed index alone, so a repeat probe re-extracts (and a
    // short chapter the narrative heuristics would skip is still probeable).
    "--from", chapterArg,
    "--to", chapterArg,
    "--force", chapterArg,
    "--model", model,
    "--out-dir", probeDir(parsedJsonPath, model),
    ...(rosterPath === null ? [] : ["--roster", rosterPath]),
  ];
}

function main(): void {
  let args: string[];
  try {
    args = probeArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, [path.join(__dirname, "extract-book.ts"), ...args], { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`Could not run extract-book.ts: ${err.message}`);
    process.exitCode = 1;
  });
  // Pass the spawned command's outcome straight through — a wrapper that
  // reported its own exit code would be a second opinion about what happened.
  child.on("exit", (code, signal) => {
    process.exitCode = signal !== null ? 1 : code ?? 1;
  });
}

if (require.main === module) {
  main();
}
