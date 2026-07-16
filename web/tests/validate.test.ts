import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError, crossCheck, validateParsedBook, validateThread } from "../src/lib/validate";
import { makeParsedBook, makeThread } from "./fixtures";

function expectFailure(fn: () => void, messagePart: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
    assert.ok(
      err.message.includes(messagePart),
      `expected message containing "${messagePart}", got "${err.message}"`
    );
    return;
  }
  assert.fail("expected validation to throw");
}

test("valid parsed book and thread pass validation and cross-check", () => {
  const parsed = makeParsedBook();
  const thread = makeThread();
  validateParsedBook(parsed);
  validateThread(thread);
  crossCheck(parsed, thread);
});

test("parsed book without chapters is rejected with a slot hint", () => {
  expectFailure(() => validateParsedBook({ sourceFile: "x" }), "-parsed.json");
});

test("thread uploaded into the parsed slot is rejected", () => {
  expectFailure(() => validateParsedBook(makeThread() as unknown), "-parsed.json");
});

test("parsed book uploaded into the thread slot is rejected", () => {
  expectFailure(() => validateThread(makeParsedBook() as unknown), "-thread.json");
});

test("duplicate parsed chapter indices are rejected", () => {
  const parsed = makeParsedBook();
  parsed.chapters[1] = { ...parsed.chapters[1], index: 0 };
  expectFailure(() => validateParsedBook(parsed), "duplicate chapter index");
});

test("thread with empty meta.slug is rejected", () => {
  const thread = makeThread();
  thread.meta.slug = "";
  expectFailure(() => validateThread(thread), "meta.slug");
});

test("thread meta counts must match array lengths", () => {
  const thread = makeThread();
  thread.meta.characterCount = 99;
  expectFailure(() => validateThread(thread), "characterCount");
});

test("invalid character role is rejected with its path", () => {
  const thread = makeThread() as unknown as { characters: { appearances: { role: string }[] }[] };
  thread.characters[0].appearances[0].role = "protagonist";
  expectFailure(() => validateThread(thread), "appearances[0].role");
});

test("null event participant ids are allowed", () => {
  validateThread(makeThread());
});

test("thread meta warningCount must match warnings length", () => {
  const thread = makeThread();
  thread.warnings = ["ch2: something unresolved"];
  expectFailure(() => validateThread(thread), "warningCount");
});

test("malformed conflict entries are rejected with their path", () => {
  const thread = makeThread();
  thread.meta.conflictCount = 1;
  thread.conflicts = [
    {
      from: { chapterIndex: 1, value: "Red" },
      to: { chapterIndex: 2 }, // missing value
      characterId: "hen",
      characterName: "Hen",
    },
  ] as never;
  expectFailure(() => validateThread(thread), "conflicts[0].to.value");
});

test("cross-check rejects conflicts referencing chapters the parsed book lacks", () => {
  const thread = makeThread();
  thread.meta.conflictCount = 1;
  thread.conflicts = [
    {
      from: { chapterIndex: 1, value: "Red" },
      to: { chapterIndex: 40, value: "Green" },
      characterId: "hen",
      characterName: "Hen",
    },
  ];
  validateThread(thread);
  expectFailure(() => crossCheck(makeParsedBook(), thread), "mismatched pair");
});

test("cross-check rejects a thread referencing chapters the parsed book lacks", () => {
  const parsed = makeParsedBook();
  const thread = makeThread();
  thread.events[0].chapterIndex = 40;
  expectFailure(() => crossCheck(parsed, thread), "mismatched pair");
});

test("cross-check rejects differing book titles", () => {
  const parsed = makeParsedBook({ title: "A Different Book" });
  const thread = makeThread();
  expectFailure(() => crossCheck(parsed, thread), "mismatched pair");
});

test("cross-check tolerates a null parsed title", () => {
  const parsed = makeParsedBook({ title: null });
  crossCheck(parsed, makeThread());
});
