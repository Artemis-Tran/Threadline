// One-off migration: repair chapter extracts stamped with the model string the
// vendor returned instead of the registry ID that was requested.
//
// Background is in ADR-0008. `extract-book` used to stamp `response.model`, so
// an Anthropic alias resolved to a dated snapshot ("claude-haiku-4-5-20251001")
// landed in an extract's `meta.model` while its manifest carried the registry ID
// ("claude-haiku-4-5"). The reuse guard compares that recorded value against the
// resolved `--model` exactly, so such a directory rejects all of its own cached
// extracts — on a normal run and on a `--rebuild-manifest` alike. Paid output
// that can be neither resumed against nor rebuilt from.
//
// This moves the recorded value to `modelReturned` and writes the manifest's
// registry ID in its place. Metadata only: nothing is re-extracted, no API call
// is made, and `extraction` is passed through untouched.
//
// It is deliberately a throwaway living outside src/. The fix in `extract-book`
// is what stops new extracts needing this; the script exists to repair the ones
// already on disk, and is committed as the record of what was done to them.
//
// Usage:
//   tsx scripts/migrate-extract-model-stamp.ts <run-dir>... [--apply]
//
// Dry-run by default — it prints exactly what it would change and writes
// nothing. Pass --apply once that output has been read.
//
// READ THE DRY RUN. This script takes the sibling manifest as the authority on
// what was requested, and it does NOT check that a recorded value looks like a
// snapshot of that manifest's model — doing so would mean prefix-matching model
// IDs, which is the second, weaker source of truth the registry exists to keep
// out. So a directory that had genuinely been served by two models (an extract
// forced with `--model haiku` inside a Sonnet run, say) would be relabelled to
// the manifest's ID here, and the reuse guard would then pass on a mixed
// directory it should have failed closed on. The one defence is the operator:
// every rewrite prints as `model "X" → "Y"`, where a wrong vendor family is
// plain to a reader. Confirm each line before passing --apply.

import * as fs from "fs";
import * as path from "path";
import { resolveModel } from "../src/models";

const EXTRACT_RE = /^idx(\d+)-extract\.json$/;
const MANIFEST_FILE = "manifest.json";

// A registry ID, as opposed to a shorthand or a vendor's dated snapshot. Asked
// of the registry rather than by prefix-matching an ID's shape: the registry is
// the authority on model identity (see src/models.ts), and this script must not
// introduce the second, weaker source of truth that the reuse guard was
// deliberately kept free of.
function isRegistryId(value: string): boolean {
  try {
    return resolveModel(value).id === value;
  } catch {
    return false;
  }
}

// One extract to restamp. The parsed body rides along so the apply pass writes
// exactly the object the dry run reported on, rather than re-reading and
// re-parsing a file it has already proved readable.
interface Rewrite {
  file: string;
  extract: Record<string, unknown>;
  // What the vendor served and the extract wrongly recorded under `model`.
  servedId: string;
  // The manifest's registry ID, which is what `model` should have held.
  registryId: string;
}

// Rebuild `meta` with the registry ID under `model` and the served string under
// `modelReturned`, placed immediately after it. Key order is otherwise preserved
// so a migrated extract's meta reads the same as one a fixed run writes fresh.
function restamp(meta: Record<string, unknown>, registryId: string, served: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === "modelReturned") continue;
    out[key] = key === "model" ? registryId : value;
    if (key === "model") out.modelReturned = served;
  }
  return out;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Returns the rewrites this directory needs, or null if it cannot be migrated at
// all — in which case the reason has already been printed.
function planDirectory(dir: string): Rewrite[] | null {
  const manifest = readJson(path.join(dir, MANIFEST_FILE));
  const manifestModel = (manifest?.meta as { model?: unknown } | undefined)?.model;

  // The manifest's registry ID is the only evidence of what was actually
  // requested. Without a usable one there is nothing to migrate *to*, and
  // guessing — by stripping a date suffix, say — is exactly the prefix-sniffing
  // this repair exists to avoid.
  if (typeof manifestModel !== "string") {
    console.log(`  skipped: no readable ${MANIFEST_FILE} meta.model — nothing to migrate to`);
    return null;
  }
  if (!isRegistryId(manifestModel)) {
    console.log(`  skipped: manifest meta.model "${manifestModel}" is not a registry ID either`);
    return null;
  }
  console.log(`  manifest model: ${manifestModel}`);

  const rewrites: Rewrite[] = [];
  const mixed: string[] = [];
  let unchanged = 0;

  for (const file of fs.readdirSync(dir).sort()) {
    if (!EXTRACT_RE.test(file)) continue;
    const extract = readJson(path.join(dir, file));
    if (extract === null) {
      console.log(`  ${file}: not valid JSON — left alone`);
      continue;
    }
    const meta = extract.meta;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      console.log(`  ${file}: no meta object — left alone`);
      continue;
    }
    const recorded = (meta as Record<string, unknown>).model;
    if (typeof recorded !== "string") {
      console.log(`  ${file}: no meta.model — left alone`);
      continue;
    }
    if (isRegistryId(recorded)) {
      // Already a registry ID, so nothing here needs moving — but if it is a
      // *different* registry ID from the manifest's, this directory holds two
      // models and the guard is right to fail closed on it. Say so rather than
      // counting it among the healthy ones.
      if (recorded === manifestModel) unchanged++;
      else mixed.push(`${file} (${recorded})`);
      continue;
    }
    // A `modelReturned` already present and disagreeing would mean this extract
    // is not the shape this migration was written for. Refuse rather than
    // overwrite a record of what a vendor actually served.
    const existingReturned = (meta as Record<string, unknown>).modelReturned;
    if (typeof existingReturned === "string" && existingReturned !== recorded) {
      console.log(
        `  ${file}: already has modelReturned "${existingReturned}" alongside model "${recorded}" — left alone, inspect by hand`
      );
      continue;
    }
    rewrites.push({ file, extract, servedId: recorded, registryId: manifestModel });
  }

  if (unchanged > 0) console.log(`  ${unchanged} extract(s) already carry the manifest's registry ID — no change`);
  if (mixed.length > 0) {
    console.log(`  MIXED DIRECTORY — ${mixed.length} extract(s) carry a registry ID that is not the manifest's:`);
    for (const m of mixed) console.log(`    ${m}`);
    console.log("    Left alone. These are not this migration's business, and the reuse guard is right to reject them.");
  }
  for (const r of rewrites) {
    console.log(`  ${r.file}: model "${r.servedId}" → "${r.registryId}", modelReturned ← "${r.servedId}"`);
  }
  return rewrites;
}

function applyRewrites(dir: string, rewrites: Rewrite[]): void {
  for (const rewrite of rewrites) {
    rewrite.extract.meta = restamp(
      rewrite.extract.meta as Record<string, unknown>,
      rewrite.registryId,
      rewrite.servedId
    );
    fs.writeFileSync(path.join(dir, rewrite.file), JSON.stringify(rewrite.extract, null, 2), "utf-8");
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dirs = argv.filter((a) => a !== "--apply");

  if (dirs.length === 0) {
    console.error("Usage: tsx scripts/migrate-extract-model-stamp.ts <run-dir>... [--apply]");
    process.exitCode = 1;
    return;
  }

  console.log(apply ? "APPLYING — files will be rewritten." : "Dry run — nothing will be written. Pass --apply to write.");

  let totalRewrites = 0;
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    console.log("");
    console.log(resolved);
    if (!fs.existsSync(resolved)) {
      console.log("  skipped: no such directory");
      continue;
    }
    const rewrites = planDirectory(resolved);
    if (rewrites === null) continue;
    if (rewrites.length === 0) {
      console.log("  → no changes needed");
      continue;
    }
    totalRewrites += rewrites.length;
    if (apply) {
      applyRewrites(resolved, rewrites);
      console.log(`  → rewrote ${rewrites.length} extract(s)`);
    } else {
      console.log(`  → would rewrite ${rewrites.length} extract(s)`);
    }
  }

  console.log("");
  console.log(
    apply
      ? `Done — ${totalRewrites} extract(s) rewritten. Metadata only; no extraction was re-run.`
      : `${totalRewrites} extract(s) would be rewritten. Re-run with --apply to write.`
  );
}

main();
