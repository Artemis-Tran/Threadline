import type { ParsedBook, Thread } from "@pipeline/types";

// Hand-rolled assertion guards for the two upload payloads. The trust boundary
// is the user's own pipeline output, so the goal is catching the wrong file in
// the wrong slot (or a mismatched book pair) with a specific message — not
// adversarial input. Validation is complete: every element is checked, and
// meta counts must agree with the arrays they describe.

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

function num(x: unknown, path: string): number {
  if (typeof x !== "number" || Number.isNaN(x)) fail(path, "expected a number");
  return x;
}

function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) fail(path, "expected an array");
  return x;
}

function strArr(x: unknown, path: string): void {
  for (const [i, v] of arr(x, path).entries()) str(v, `${path}[${i}]`);
}

export function validateParsedBook(x: unknown): asserts x is ParsedBook {
  if (!isObj(x)) fail("parsed file", "not a JSON object — is this a -parsed.json?");
  if (!("chapters" in x)) fail("parsed file", "missing chapters — is this a -parsed.json?");
  str(x.sourceFile, "parsed.sourceFile");
  strOrNull(x.title, "parsed.title");
  strOrNull(x.creator, "parsed.creator");
  strOrNull(x.language, "parsed.language");
  int(x.chapterCount, "parsed.chapterCount");
  num(x.wordCount, "parsed.wordCount");
  const chapters = arr(x.chapters, "parsed.chapters");
  if (chapters.length === 0) fail("parsed.chapters", "empty — nothing to import");
  const seen = new Set<number>();
  for (const [i, c] of chapters.entries()) {
    const p = `parsed.chapters[${i}]`;
    if (!isObj(c)) fail(p, "expected an object");
    const index = int(c.index, `${p}.index`);
    if (index < 0) fail(`${p}.index`, "negative chapter index");
    if (seen.has(index)) fail(`${p}.index`, `duplicate chapter index ${index}`);
    seen.add(index);
    str(c.id, `${p}.id`);
    str(c.href, `${p}.href`);
    strOrNull(c.title, `${p}.title`);
    num(c.wordCount, `${p}.wordCount`);
    str(c.text, `${p}.text`);
  }
}

function validateConflictBound(b: unknown, path: string): void {
  if (!isObj(b)) fail(path, "expected an object");
  int(b.chapterIndex, `${path}.chapterIndex`);
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
  const chapterIndex = int(s.chapterIndex, `${path}.chapterIndex`);
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
    int(c.firstAppearedChapterIndex, `${p}.firstAppearedChapterIndex`);
    int(c.lastAppearedChapterIndex, `${p}.lastAppearedChapterIndex`);
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
      int(a.chapterIndex, `${q}.chapterIndex`);
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
    int(e.chapterIndex, `${p}.chapterIndex`);
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

  // Denormalized meta counts feed the book list; if they disagree with the
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

// Every chapterIndex the thread references anywhere must exist in the parsed
// chapter set, and the two files must agree on the book title — together these
// catch a thread uploaded with the wrong book's parsed file.
export function crossCheck(parsed: ParsedBook, thread: Thread): void {
  const parsedIndices = new Set(parsed.chapters.map((c) => c.index));
  const check = (index: number, path: string) => {
    if (!parsedIndices.has(index)) {
      fail(path, `references chapterIndex ${index}, which does not exist in the parsed book — mismatched pair?`);
    }
  };
  for (const [i, c] of thread.characters.entries()) {
    check(c.firstAppearedChapterIndex, `thread.characters[${i}].firstAppearedChapterIndex`);
    check(c.lastAppearedChapterIndex, `thread.characters[${i}].lastAppearedChapterIndex`);
    for (const [j, a] of c.appearances.entries()) check(a.chapterIndex, `thread.characters[${i}].appearances[${j}]`);
    for (const [j, cf] of c.conflicts.entries()) {
      check(cf.from.chapterIndex, `thread.characters[${i}].conflicts[${j}].from`);
      check(cf.to.chapterIndex, `thread.characters[${i}].conflicts[${j}].to`);
    }
    for (const [j, pr] of c.progressionRegressions.entries()) {
      check(pr.from.chapterIndex, `thread.characters[${i}].progressionRegressions[${j}].from`);
      check(pr.to.chapterIndex, `thread.characters[${i}].progressionRegressions[${j}].to`);
    }
  }
  for (const [i, cf] of thread.conflicts.entries()) {
    check(cf.from.chapterIndex, `thread.conflicts[${i}].from`);
    check(cf.to.chapterIndex, `thread.conflicts[${i}].to`);
  }
  for (const [i, pr] of thread.progressionRegressions.entries()) {
    check(pr.from.chapterIndex, `thread.progressionRegressions[${i}].from`);
    check(pr.to.chapterIndex, `thread.progressionRegressions[${i}].to`);
  }
  for (const [i, r] of thread.relationships.entries()) {
    check(r.current.chapterIndex, `thread.relationships[${i}].current`);
    for (const [j, s] of r.history.entries()) check(s.chapterIndex, `thread.relationships[${i}].history[${j}]`);
  }
  for (const [i, e] of thread.events.entries()) check(e.chapterIndex, `thread.events[${i}]`);

  const parsedTitle = parsed.title?.trim();
  const threadTitle = thread.meta.bookTitle?.trim();
  if (parsedTitle && threadTitle && parsedTitle !== threadTitle) {
    fail(
      "book title",
      `parsed file says "${parsedTitle}" but thread says "${threadTitle}" — mismatched pair?`
    );
  }
}
