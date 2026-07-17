import type { Thread } from "@pipeline/types";

// Hand-rolled assertion guard for the single upload payload. The trust boundary
// is the user's own pipeline output, so the goal is catching the wrong file in
// the thread slot (or a hand-edited/truncated file) with a specific message —
// not adversarial input. Validation is complete: every element is checked, and
// meta counts must agree with the arrays they describe.
//
// Thread-only: there is no parsed book to cross-check against, so chapter
// indices are validated intrinsically — every referenced index must be a
// non-negative integer. There is deliberately no upper-bound check:
// `meta.chapterCount` is the extracted-chapter count (chunks.length), not a
// chapter-index bound, so it can't serve as one. The wiki derives its chapter
// range from the actual referenced indices instead (see asOf.ts).

export class ValidationError extends Error {}

const CHARACTER_ROLES = new Set(["pov", "major", "supporting", "minor", "mentioned"]);
const EVENT_SIGNIFICANCE = new Set(["major", "moderate", "minor"]);

function fail(path: string, msg: string): never {
  throw new ValidationError(`${path}: ${msg}`);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown, path: string): string {
  if (typeof x !== "string") fail(path, "expected a string");
  return x;
}

function strOrNull(x: unknown, path: string): string | null {
  if (x !== null && typeof x !== "string") fail(path, "expected a string or null");
  return x as string | null;
}

function int(x: unknown, path: string): number {
  if (typeof x !== "number" || !Number.isInteger(x)) fail(path, "expected an integer");
  return x;
}

// Every chapter index anywhere in the thread flows through here.
function nonNegativeInt(x: unknown, path: string): number {
  const n = int(x, path);
  if (n < 0) fail(path, "expected a non-negative integer");
  return n;
}

function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) fail(path, "expected an array");
  return x;
}

function strArr(x: unknown, path: string): void {
  for (const [i, v] of arr(x, path).entries()) str(v, `${path}[${i}]`);
}

function validateConflictBound(b: unknown, path: string): void {
  if (!isObj(b)) fail(path, "expected an object");
  nonNegativeInt(b.chapterIndex, `${path}.chapterIndex`);
  str(b.value, `${path}.value`);
}

// TierConflict / ProgressionRegression share the from/to shape; the flattened
// top-level variants additionally carry characterId/characterName, and
// progression regressions carry a key.
function validateConflict(
  c: unknown,
  path: string,
  opts: { flattened: boolean; keyed: boolean }
): void {
  if (!isObj(c)) fail(path, "expected an object");
  validateConflictBound(c.from, `${path}.from`);
  validateConflictBound(c.to, `${path}.to`);
  if (opts.keyed) str(c.key, `${path}.key`);
  if (opts.flattened) {
    str(c.characterId, `${path}.characterId`);
    str(c.characterName, `${path}.characterName`);
  }
}

function validateStatement(s: unknown, path: string): number {
  if (!isObj(s)) fail(path, "expected an object");
  const chapterIndex = nonNegativeInt(s.chapterIndex, `${path}.chapterIndex`);
  strOrNull(s.chapterTitle, `${path}.chapterTitle`);
  str(s.fromId, `${path}.fromId`);
  str(s.fromName, `${path}.fromName`);
  str(s.toId, `${path}.toId`);
  str(s.toName, `${path}.toName`);
  str(s.type, `${path}.type`);
  str(s.description, `${path}.description`);
  return chapterIndex;
}

export function validateThread(x: unknown): asserts x is Thread {
  if (!isObj(x)) fail("thread file", "not a JSON object — is this a -thread.json?");
  if (!isObj(x.meta)) fail("thread.meta", "missing — is this a -thread.json?");
  const meta = x.meta;
  if (typeof meta.slug !== "string" || meta.slug.length === 0) {
    fail("thread.meta.slug", "missing or empty — is this a -thread.json?");
  }
  strOrNull(meta.bookTitle, "thread.meta.bookTitle");
  str(meta.sourceManifest, "thread.meta.sourceManifest");
  str(meta.generatedAt, "thread.meta.generatedAt");
  int(meta.chapterCount, "thread.meta.chapterCount");
  int(meta.characterCount, "thread.meta.characterCount");
  int(meta.relationshipCount, "thread.meta.relationshipCount");
  int(meta.eventCount, "thread.meta.eventCount");
  int(meta.conflictCount, "thread.meta.conflictCount");
  int(meta.progressionRegressionCount, "thread.meta.progressionRegressionCount");
  int(meta.warningCount, "thread.meta.warningCount");

  const characters = arr(x.characters, "thread.characters");
  for (const [i, c] of characters.entries()) {
    const p = `thread.characters[${i}]`;
    if (!isObj(c)) fail(p, "expected an object");
    if (typeof c.id !== "string" || c.id.length === 0) fail(`${p}.id`, "missing or empty");
    str(c.name, `${p}.name`);
    strArr(c.aliases, `${p}.aliases`);
    str(c.description, `${p}.description`);
    nonNegativeInt(c.firstAppearedChapterIndex, `${p}.firstAppearedChapterIndex`);
    nonNegativeInt(c.lastAppearedChapterIndex, `${p}.lastAppearedChapterIndex`);
    for (const [j, cf] of arr(c.conflicts, `${p}.conflicts`).entries()) {
      validateConflict(cf, `${p}.conflicts[${j}]`, { flattened: false, keyed: false });
    }
    for (const [j, pr] of arr(c.progressionRegressions, `${p}.progressionRegressions`).entries()) {
      validateConflict(pr, `${p}.progressionRegressions[${j}]`, { flattened: false, keyed: true });
    }
    const appearances = arr(c.appearances, `${p}.appearances`);
    if (appearances.length === 0) fail(`${p}.appearances`, "empty — every character needs at least one appearance");
    for (const [j, a] of appearances.entries()) {
      const q = `${p}.appearances[${j}]`;
      if (!isObj(a)) fail(q, "expected an object");
      nonNegativeInt(a.chapterIndex, `${q}.chapterIndex`);
      strOrNull(a.chapterTitle, `${q}.chapterTitle`);
      str(a.name, `${q}.name`);
      strArr(a.aliases, `${q}.aliases`);
      str(a.description, `${q}.description`);
      if (typeof a.role !== "string" || !CHARACTER_ROLES.has(a.role)) {
        fail(`${q}.role`, `expected one of ${[...CHARACTER_ROLES].join("/")}`);
      }
    }
  }

  const relationships = arr(x.relationships, "thread.relationships");
  for (const [i, r] of relationships.entries()) {
    const p = `thread.relationships[${i}]`;
    if (!isObj(r)) fail(p, "expected an object");
    str(r.id, `${p}.id`);
    const participants = arr(r.participantIds, `${p}.participantIds`);
    if (participants.length !== 2) fail(`${p}.participantIds`, "expected exactly two participant ids");
    strArr(r.participantIds, `${p}.participantIds`);
    validateStatement(r.current, `${p}.current`);
    const history = arr(r.history, `${p}.history`);
    if (history.length === 0) fail(`${p}.history`, "empty — every relationship needs at least one statement");
    for (const [j, s] of history.entries()) validateStatement(s, `${p}.history[${j}]`);
  }

  const events = arr(x.events, "thread.events");
  for (const [i, e] of events.entries()) {
    const p = `thread.events[${i}]`;
    if (!isObj(e)) fail(p, "expected an object");
    nonNegativeInt(e.chapterIndex, `${p}.chapterIndex`);
    strOrNull(e.chapterTitle, `${p}.chapterTitle`);
    str(e.summary, `${p}.summary`);
    if (typeof e.significance !== "string" || !EVENT_SIGNIFICANCE.has(e.significance)) {
      fail(`${p}.significance`, `expected one of ${[...EVENT_SIGNIFICANCE].join("/")}`);
    }
    for (const [j, ci] of arr(e.charactersInvolved, `${p}.charactersInvolved`).entries()) {
      const q = `${p}.charactersInvolved[${j}]`;
      if (!isObj(ci)) fail(q, "expected an object");
      if (ci.id !== null && typeof ci.id !== "string") fail(`${q}.id`, "expected a string or null");
      str(ci.name, `${q}.name`);
    }
  }

  const conflicts = arr(x.conflicts, "thread.conflicts");
  for (const [i, c] of conflicts.entries()) {
    validateConflict(c, `thread.conflicts[${i}]`, { flattened: true, keyed: false });
  }
  const progressionRegressions = arr(x.progressionRegressions, "thread.progressionRegressions");
  for (const [i, pr] of progressionRegressions.entries()) {
    validateConflict(pr, `thread.progressionRegressions[${i}]`, { flattened: true, keyed: true });
  }
  const warnings = arr(x.warnings, "thread.warnings");
  for (const [i, w] of warnings.entries()) str(w, `thread.warnings[${i}]`);

  // Denormalized meta counts feed the library card; if they disagree with the
  // arrays, the file was hand-edited or truncated — refuse rather than guess.
  if (meta.characterCount !== characters.length) {
    fail("thread.meta.characterCount", `is ${meta.characterCount} but characters has ${characters.length}`);
  }
  if (meta.relationshipCount !== relationships.length) {
    fail("thread.meta.relationshipCount", `is ${meta.relationshipCount} but relationships has ${relationships.length}`);
  }
  if (meta.eventCount !== events.length) {
    fail("thread.meta.eventCount", `is ${meta.eventCount} but events has ${events.length}`);
  }
  if (meta.conflictCount !== conflicts.length) {
    fail("thread.meta.conflictCount", `is ${meta.conflictCount} but conflicts has ${conflicts.length}`);
  }
  if (meta.progressionRegressionCount !== progressionRegressions.length) {
    fail(
      "thread.meta.progressionRegressionCount",
      `is ${meta.progressionRegressionCount} but progressionRegressions has ${progressionRegressions.length}`
    );
  }
  if (meta.warningCount !== warnings.length) {
    fail("thread.meta.warningCount", `is ${meta.warningCount} but warnings has ${warnings.length}`);
  }
}
