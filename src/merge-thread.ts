import * as fs from "fs";
import * as path from "path";
import {
  Extraction,
  Manifest,
  deriveSlug,
  THREAD_SUFFIX,
  TIER_ORDER,
  TierName,
  TierConflict,
  FlattenedConflict,
  ProgressionOrder,
  ProgressionRegression,
  FlattenedProgressionRegression,
  CharacterAppearance,
  MergedCharacter,
  RelationshipStatement,
  MergedRelationship,
  MergedEvent,
  Thread,
} from "./types";
import {
  sanitizeName,
  sanitizeAliases,
  findIdentityMatch,
  identityOverlaps,
  identifierSet,
  Identified,
} from "./identity";

const MANIFEST_FILE = "manifest.json";

export interface CliOptions {
  parsedJsonPath: string;
  dryRun: boolean;
  outPath: string | null;
  progressionOrderPath: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { parsedJsonPath: "", dryRun: false, outPath: null, progressionOrderPath: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--out": {
        const next = argv[++i];
        if (!next || next.startsWith("--")) throw new Error("--out expects a file path");
        opts.outPath = next;
        break;
      }
      case "--progression-order": {
        const next = argv[++i];
        if (!next || next.startsWith("--")) throw new Error("--progression-order expects a file path");
        opts.progressionOrderPath = next;
        break;
      }
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
        if (opts.parsedJsonPath) throw new Error(`Unexpected argument: ${arg}`);
        opts.parsedJsonPath = arg;
    }
  }

  if (!opts.parsedJsonPath) {
    throw new Error(
      "Usage: tsx src/merge-thread.ts <parsed-json-path-or-slug> [--dry-run] [--out <path>] [--progression-order <path>]"
    );
  }
  return opts;
}

export function loadManifest(chunksDir: string): Manifest {
  const manifestPath = path.join(chunksDir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No manifest found at ${manifestPath}. Run extract-book.ts <parsed-json-path> first.`);
  }
  // Name the offending file on bad data rather than surfacing a bare
  // SyntaxError/TypeError (same convention as loadChunks below).
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new Error(`Manifest at ${manifestPath} is not valid JSON — re-run extract-book.ts to regenerate it.`);
  }
  const manifest = parsed as Manifest;
  if (!manifest?.meta || !Array.isArray(manifest.chapters)) {
    throw new Error(`Manifest at ${manifestPath} has no valid meta/chapters — re-run extract-book.ts to regenerate it.`);
  }
  if (!manifest.meta.complete) {
    throw new Error(
      `Manifest at ${manifestPath} is not complete (meta.complete=false); merge-thread requires a finished extract-book.ts run.`
    );
  }
  return manifest;
}

export interface ChunkData {
  chapterIndex: number;
  chapterTitle: string | null;
  extraction: Extraction;
}

export function loadChunks(chunksDir: string, manifest: Manifest): ChunkData[] {
  return manifest.chapters
    .filter((c): c is typeof c & { file: string } => !!c.file)
    .sort((a, b) => a.index - b.index)
    .map((entry) => {
      const filePath = path.join(chunksDir, entry.file);
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `Manifest references ${entry.file} for chapter ${entry.index} but it does not exist at ${filePath}.`
        );
      }
      // Name the offending file on bad data rather than surfacing a bare
      // SyntaxError/TypeError from deep inside the merge (mirrors
      // extract-book.ts's readCheckpointCharacters).
      let checkpoint: unknown;
      try {
        checkpoint = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        throw new Error(
          `Chunk ${entry.file} (chapter ${entry.index}) is not valid JSON — re-extract it with extract-book.ts --force ${entry.index}.`
        );
      }
      const extraction = (checkpoint as { extraction?: Extraction })?.extraction;
      if (
        !extraction ||
        !Array.isArray(extraction.characters) ||
        !Array.isArray(extraction.relationships) ||
        !Array.isArray(extraction.events)
      ) {
        throw new Error(
          `Chunk ${entry.file} (chapter ${entry.index}) has no valid extraction object — re-extract it with extract-book.ts --force ${entry.index}.`
        );
      }
      return {
        chapterIndex: entry.index,
        chapterTitle: entry.title,
        extraction,
      };
    });
}

// Tier is now the built-in default entry of a generic, configurable-per-key
// progression-order engine (below) rather than a separate hardcoded path —
// this is exactly today's TIER_ORDER/tier-word regex, expressed as data.
export const DEFAULT_PROGRESSION_ORDERS: ProgressionOrder[] = [
  { key: "Tier", order: [...TIER_ORDER], descriptionPattern: "{value}\\s+tier\\b" },
];

// Order values and key names are human-authored config, not guaranteed
// regex-safe (e.g. "A+"/"S-rank" tier-suffix conventions are common in this
// genre) — escape before interpolating into a RegExp source string.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the FIRST value matched in the description (not last, not
// highest) for the given order — this book's prose states current status
// before any aspirational target ("Now a Red tier Mystic Potter... hopes to
// reach Orange tier"), so a first-match reading is the one tuned to that
// convention. A book phrasing it the other way around would defeat this
// heuristic; that's an accepted limitation of a regex-only, no-attribution
// approach, generic across every configured key, not just Tier.
export function extractProgressionValue(description: string, order: ProgressionOrder): string | null {
  const escapedValues = order.order.map(escapeRegExp).join("|");
  const pattern = order.descriptionPattern.replace("{value}", `(${escapedValues})`);
  const regex = new RegExp(`\\b${pattern}`, "i");
  const m = regex.exec(description);
  // A descriptionPattern missing the {value} placeholder leaves no capturing
  // group; loadProgressionOrders() rejects that case at load time, but treat
  // it as "no match" here too rather than crashing on m[1] being undefined.
  if (!m || m[1] === undefined) return null;
  return order.order.find((v) => v.toLowerCase() === m[1].toLowerCase()) ?? null;
}

// Flags any pairwise-adjacent rank decrease across a character's
// value-bearing appearances (chapter order), per configured key. Same
// known, regex-only heuristic with no subject attribution as the original
// tier-only detector — a description mentioning someone else's value in the
// same sentence ("recognizing her exceptional Orange tier potential") can be
// misattributed to this character. Documented limitation, not a bug to patch
// away with ad hoc regex tweaks.
export function detectProgressionRegressions(
  appearances: CharacterAppearance[],
  orders: ProgressionOrder[]
): ProgressionRegression[] {
  const regressions: ProgressionRegression[] = [];
  for (const order of orders) {
    const timeline = appearances
      .map((a) => ({ chapterIndex: a.chapterIndex, value: extractProgressionValue(a.description, order) }))
      .filter((t): t is { chapterIndex: number; value: string } => t.value !== null);

    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (order.order.indexOf(curr.value) < order.order.indexOf(prev.value)) {
        regressions.push({
          key: order.key,
          from: { chapterIndex: prev.chapterIndex, value: prev.value },
          to: { chapterIndex: curr.chapterIndex, value: curr.value },
        });
      }
    }
  }
  return regressions;
}

function toTierConflicts(regressions: ProgressionRegression[]): TierConflict[] {
  return regressions.map((r) => ({
    from: { chapterIndex: r.from.chapterIndex, value: r.from.value },
    to: { chapterIndex: r.to.chapterIndex, value: r.to.value },
  }));
}

// Backward-compatible wrappers: same exported names, signatures, and output
// shapes as before this refactor. Tier is not deprecated — it's unified onto
// the same engine every other configured key uses, via DEFAULT_PROGRESSION_ORDERS[0].
// These always use the built-in default (never a config override) — see
// buildCharacters()'s tierOrder parameter for the path that does honor
// --progression-order overrides of the "Tier" key.
export function extractTier(description: string): TierName | null {
  return extractProgressionValue(description, DEFAULT_PROGRESSION_ORDERS[0]) as TierName | null;
}

export function detectTierConflicts(appearances: CharacterAppearance[]): TierConflict[] {
  return toTierConflicts(detectProgressionRegressions(appearances, [DEFAULT_PROGRESSION_ORDERS[0]]));
}

// Loads per-key progression orders for detection: starts from the built-in
// Tier default, optionally merging in a human-supplied config file's entries
// by key (config wins on collision — a book could even override Tier's own
// pattern/order). No order is ever inferred/guessed from book text; a new
// key only gets checked once a human explicitly supplies it here.
export function loadProgressionOrders(configPath?: string | null): ProgressionOrder[] {
  const merged = new Map<string, ProgressionOrder>(DEFAULT_PROGRESSION_ORDERS.map((o) => [o.key, o]));
  if (!configPath) return [...merged.values()];

  if (!fs.existsSync(configPath)) {
    throw new Error(`--progression-order file not found: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`--progression-order file at ${configPath} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `--progression-order file at ${configPath} must be a JSON object of { key: { order: string[], descriptionPattern?: string } }.`
    );
  }

  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = raw as { order?: unknown; descriptionPattern?: unknown };
    if (!Array.isArray(entry.order) || entry.order.length === 0 || entry.order.some((v) => typeof v !== "string")) {
      throw new Error(`--progression-order entry "${key}" must have a non-empty "order" array of strings.`);
    }
    if (typeof entry.descriptionPattern === "string" && !entry.descriptionPattern.includes("{value}")) {
      throw new Error(`--progression-order entry "${key}" descriptionPattern must contain a "{value}" placeholder.`);
    }
    // Case-insensitive collision: a config key matching an existing entry's
    // key (e.g. "tier" against the built-in "Tier") overrides that entry in
    // place rather than creating a second, near-duplicate tracked axis —
    // "Tier" is the one key with dedicated dual-bucket handling in
    // buildThread(), so a casing mismatch here must not silently defeat that.
    const existingKey = [...merged.keys()].find((k) => k.toLowerCase() === key.toLowerCase());
    if (existingKey !== undefined) merged.delete(existingKey);
    merged.set(key, {
      key,
      order: entry.order as string[],
      descriptionPattern:
        typeof entry.descriptionPattern === "string"
          ? entry.descriptionPattern
          : `{value}\\s+${escapeRegExp(key)}\\b`,
    });
  }
  return [...merged.values()];
}

export function slugifyId(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "character";
}

export function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Fold `source` into `target` after a late-discovered identity overlap. The
// finalize pass in buildCharacters dedupes aliases and strips the final name,
// so this can append liberally.
function absorb(target: MergedCharacter, source: MergedCharacter): void {
  target.appearances = [...target.appearances, ...source.appearances].sort(
    (a, b) => a.chapterIndex - b.chapterIndex
  );
  target.aliases = [...target.aliases, target.name, ...source.aliases, source.name];
  if (source.name.length > target.name.length) target.name = source.name;
  target.description = target.appearances[target.appearances.length - 1].description;
  target.firstAppearedChapterIndex = Math.min(
    target.firstAppearedChapterIndex,
    source.firstAppearedChapterIndex
  );
  target.lastAppearedChapterIndex = Math.max(
    target.lastAppearedChapterIndex,
    source.lastAppearedChapterIndex
  );
}

// The greedy replay pass is order-sensitive: a character can be created under
// one name ("Lord Brennan") before a later chunk's aliases establish that an
// earlier entity already answers to it — leaving two records that share an
// identifier ("Henry" and "Henry Ashford" both holding "Mystic Potter").
// Merge to a fixed point so identifier sets end up pairwise disjoint; that
// disjointness is also what makes the post-pass nameToId index unambiguous.
export function unifyCharacters(characters: MergedCharacter[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < characters.length; i++) {
      for (let j = i + 1; j < characters.length; ) {
        if (identityOverlaps(characters[j], characters[i])) {
          absorb(characters[i], characters[j]);
          characters.splice(j, 1);
          changed = true;
        } else {
          j++;
        }
      }
    }
  }
}

// Rebuild a full per-character appearance history by replaying every chunk in
// chapter order, grouping via the same name/alias-overlap matching stage 3's
// roster hint uses (src/identity.ts). Unlike that roster, nothing here is
// destructively collapsed or capped — this is the authoritative pass, so full
// history survives in `appearances`, and the same-bare-name-different-person
// collision case (deliberately left unresolved by identity.ts's matching
// predicate) is a known, documented limitation rather than something this
// pass attempts to fix.
// tierOrder defaults to the built-in Tier entry so existing 1-arg callers
// (including the test suite) are unaffected; buildThread() passes a
// config-resolved order here so a --progression-order override of the
// "Tier" key actually reaches `conflicts` — merely excluding "Tier" from
// the generic progressionRegressions pass (below) isn't enough on its own,
// since conflicts is computed independently, right here.
export function buildCharacters(
  chunks: ChunkData[],
  tierOrder: ProgressionOrder = DEFAULT_PROGRESSION_ORDERS[0]
): { characters: MergedCharacter[]; nameToId: Map<string, string> } {
  const characters: MergedCharacter[] = [];
  const usedIds = new Set<string>();

  for (const chunk of chunks) {
    for (const raw of chunk.extraction.characters) {
      const name = sanitizeName(raw.name);
      if (name.length === 0) continue;
      const aliases = sanitizeAliases(name, raw.aliases);
      const candidate: Identified = { name, aliases };

      let target = findIdentityMatch(candidate, characters);
      if (!target) {
        const id = uniqueId(slugifyId(name), usedIds);
        usedIds.add(id);
        target = {
          id,
          name,
          aliases: [],
          description: "",
          appearances: [],
          firstAppearedChapterIndex: chunk.chapterIndex,
          lastAppearedChapterIndex: chunk.chapterIndex,
          conflicts: [],
          progressionRegressions: [],
        };
        characters.push(target);
      }

      target.appearances.push({
        chapterIndex: chunk.chapterIndex,
        chapterTitle: chunk.chapterTitle,
        name,
        aliases,
        description: raw.description,
        role: raw.role,
      });
      target.lastAppearedChapterIndex = chunk.chapterIndex;
      // Recency-first: unconditional overwrite. This is the fix for
      // updateRoster's longest-string-wins bug (extract-book.ts) — the most
      // recent chapter's description becomes canonical, full history is kept
      // in `appearances` regardless.
      target.description = raw.description;
      if (name.length > target.name.length) {
        // Keep the demoted name reachable as an alias — a match can arrive
        // via a shared alias, in which case the old name isn't otherwise in
        // the candidate's identifier set and would silently vanish.
        target.aliases.push(target.name);
        target.name = name;
      }
      for (const alias of [name, ...aliases]) {
        if (
          alias.toLowerCase() !== target.name.toLowerCase() &&
          !target.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())
        ) {
          target.aliases.push(alias);
        }
      }
    }
  }

  unifyCharacters(characters);

  // Finalize: target.name may have been promoted to a longer form after some
  // aliases were already added (or during unification), so re-filter against
  // the FINAL name.
  for (const c of characters) {
    const seen = new Set<string>();
    c.aliases = c.aliases.filter((a) => {
      const key = a.toLowerCase();
      if (key === c.name.toLowerCase() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    c.conflicts = toTierConflicts(detectProgressionRegressions(c.appearances, [tierOrder]));
  }

  // Built only AFTER unification, from the final characters: identifier sets
  // are pairwise disjoint at this point, so every lookup has exactly one
  // possible owner — unlike a during-replay map, which is last-write-wins and
  // can disagree with the grouping (a character's own statements resolving to
  // someone else's id).
  const nameToId = new Map<string, string>();
  for (const c of characters) {
    for (const ident of identifierSet(c)) nameToId.set(ident, c.id);
  }

  return { characters, nameToId };
}

export function buildRelationshipsAndEvents(
  chunks: ChunkData[],
  nameToId: Map<string, string>,
  warnings: string[]
): { relationships: MergedRelationship[]; events: MergedEvent[] } {
  function resolveName(raw: string, chapterIndex: number, field: string): { id: string | null; name: string } {
    const name = sanitizeName(raw);
    const id = nameToId.get(name.toLowerCase()) ?? null;
    if (id === null) warnings.push(`ch${chapterIndex}: ${field} references unresolved name "${raw}"`);
    return { id, name };
  }

  // Bucketed by the UNORDERED canonical-id pair, not strict (from, to)
  // direction: chunks are extracted independently per chapter with no
  // cross-chapter direction guidance, so the same pair of characters
  // frequently gets relationship statements in flipped directions across
  // different chapters. Each statement still keeps its own actually-stated
  // direction inside `history` — nothing is collapsed or invented, this only
  // avoids fragmenting one evolving relationship into two disconnected
  // records.
  const relBuckets = new Map<string, MergedRelationship>();
  for (const chunk of chunks) {
    for (const r of chunk.extraction.relationships) {
      const from = resolveName(r.from, chunk.chapterIndex, "relationship.from");
      const to = resolveName(r.to, chunk.chapterIndex, "relationship.to");
      if (from.id === null || to.id === null) continue;
      if (from.id === to.id) {
        warnings.push(
          `ch${chunk.chapterIndex}: relationship "${r.from}" -> "${r.to}" resolved to the same character (${from.id}); dropped as self-referential`
        );
        continue;
      }
      const sorted = [from.id, to.id].sort() as [string, string];
      const key = sorted.join("|");
      const statement: RelationshipStatement = {
        chapterIndex: chunk.chapterIndex,
        chapterTitle: chunk.chapterTitle,
        fromId: from.id,
        fromName: from.name,
        toId: to.id,
        toName: to.name,
        type: r.type,
        description: r.description,
      };
      const bucket = relBuckets.get(key);
      if (!bucket) {
        relBuckets.set(key, { id: sorted.join("--"), participantIds: sorted, current: statement, history: [statement] });
      } else {
        bucket.history.push(statement);
        bucket.current = statement; // chapter-ascending replay => last push is most recent
      }
    }
  }

  // Flattened in chapter order; no dedup needed since chunks are
  // chapter-scoped and non-overlapping by construction (loadChunks reads
  // exactly the manifest's chapter list, one file per chapter).
  const events: MergedEvent[] = [];
  for (const chunk of chunks) {
    for (const e of chunk.extraction.events) {
      const involved = e.characters_involved.map((n) => {
        const r = resolveName(n, chunk.chapterIndex, "event.characters_involved");
        return { id: r.id, name: r.name };
      });
      events.push({
        chapterIndex: chunk.chapterIndex,
        chapterTitle: chunk.chapterTitle,
        summary: e.summary,
        significance: e.significance,
        charactersInvolved: involved,
      });
    }
  }

  return { relationships: [...relBuckets.values()], events };
}

export function buildThread(chunksDir: string, slug: string, progressionOrderPath?: string | null): Thread {
  const manifest = loadManifest(chunksDir);
  const chunks = loadChunks(chunksDir, manifest);

  // Loaded before buildCharacters() specifically so a --progression-order
  // override of the "Tier" key actually reaches `conflicts` (buildCharacters
  // computes conflicts internally, per-character, as appearances are built).
  // Tier's own regressions stay in `conflicts` for backward compatibility;
  // every other configured key reports through `progressionRegressions`
  // instead — matched case-insensitively so a config author writing "tier"
  // gets the override, not an accidental second tracked axis.
  const orders = loadProgressionOrders(progressionOrderPath);
  const tierOrder = orders.find((o) => o.key.toLowerCase() === "tier") ?? DEFAULT_PROGRESSION_ORDERS[0];
  const nonTierOrders = orders.filter((o) => o.key.toLowerCase() !== "tier");

  const warnings: string[] = [];
  const { characters, nameToId } = buildCharacters(chunks, tierOrder);
  const { relationships, events } = buildRelationshipsAndEvents(chunks, nameToId, warnings);

  for (const c of characters) {
    c.progressionRegressions = detectProgressionRegressions(c.appearances, nonTierOrders);
  }

  const conflicts: FlattenedConflict[] = characters.flatMap((c) =>
    c.conflicts.map((conf) => ({ ...conf, characterId: c.id, characterName: c.name }))
  );
  const progressionRegressions: FlattenedProgressionRegression[] = characters.flatMap((c) =>
    c.progressionRegressions.map((reg) => ({ ...reg, characterId: c.id, characterName: c.name }))
  );

  return {
    meta: {
      bookTitle: manifest.meta.bookTitle,
      slug,
      sourceManifest: path.join(chunksDir, MANIFEST_FILE),
      generatedAt: new Date().toISOString(),
      chapterCount: chunks.length,
      characterCount: characters.length,
      relationshipCount: relationships.length,
      eventCount: events.length,
      conflictCount: conflicts.length,
      progressionRegressionCount: progressionRegressions.length,
      warningCount: warnings.length,
    },
    characters,
    relationships,
    events,
    conflicts,
    progressionRegressions,
    warnings,
  };
}

function printSummary(thread: Thread): void {
  console.log("");
  console.log("Merge summary");
  console.log("-------------");
  console.log(`Book:            ${thread.meta.bookTitle ?? "(unknown)"}`);
  console.log(`Chapters:        ${thread.meta.chapterCount}`);
  console.log(`Characters:      ${thread.meta.characterCount}`);
  console.log(`Relationships:   ${thread.meta.relationshipCount}`);
  console.log(`Events:          ${thread.meta.eventCount}`);
  console.log(`Conflicts:       ${thread.meta.conflictCount}`);
  console.log(`Progression regressions: ${thread.meta.progressionRegressionCount}`);
  console.log(`Warnings:        ${thread.meta.warningCount}`);

  if (thread.conflicts.length > 0) {
    console.log("");
    console.log("Conflicts:");
    for (const c of thread.conflicts) {
      console.log(`  ${c.characterName} (${c.characterId}): ${c.from.value}@ch${c.from.chapterIndex} -> ${c.to.value}@ch${c.to.chapterIndex}`);
    }
  }
  if (thread.progressionRegressions.length > 0) {
    console.log("");
    console.log("Progression regressions:");
    for (const r of thread.progressionRegressions) {
      console.log(
        `  ${r.characterName} (${r.characterId}) [${r.key}]: ${r.from.value}@ch${r.from.chapterIndex} -> ${r.to.value}@ch${r.to.chapterIndex}`
      );
    }
  }
  if (thread.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const w of thread.warnings) console.log(`  ${w}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const slug = deriveSlug(opts.parsedJsonPath);
  const chunksDir = path.resolve(__dirname, "..", "output", `${slug}-chunks`);

  const thread = buildThread(chunksDir, slug, opts.progressionOrderPath);
  printSummary(thread);

  if (opts.dryRun) {
    console.log("");
    console.log("Dry run — thread not written.");
    return;
  }

  const outPath = opts.outPath ?? path.resolve(__dirname, "..", "output", `${slug}${THREAD_SUFFIX}`);
  fs.writeFileSync(outPath, JSON.stringify(thread, null, 2), "utf-8");
  console.log("");
  console.log(`Thread written: ${outPath}`);
}

// Only run the CLI when executed directly — the merge functions above are
// also imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    console.error(`Merge failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
