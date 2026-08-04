import { test } from "vitest";
import assert from "node:assert/strict";
import { ValidationError, validateThread } from "../src/lib/validate";
import { makeThread } from "./fixtures";

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

test("a valid thread passes validation", () => {
  validateThread(makeThread());
});

test("a non-object is rejected with a slot hint", () => {
  expectFailure(() => validateThread("nope" as unknown), "-thread.json");
  expectFailure(() => validateThread({ characters: [] } as unknown), "-thread.json");
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

test("thread meta warningCount must match warnings length", () => {
  const thread = makeThread();
  thread.warnings = ["ch2: something unresolved"];
  expectFailure(() => validateThread(thread), "warningCount");
});

test("invalid character role is rejected with its path", () => {
  const thread = makeThread() as unknown as { characters: { appearances: { role: string }[] }[] };
  thread.characters[0].appearances[0].role = "protagonist";
  expectFailure(() => validateThread(thread), "appearances[0].role");
});

test("a valid character kind is accepted on the character and its appearances", () => {
  const thread = makeThread();
  thread.characters[0].kind = "collective";
  thread.characters[0].appearances[0].kind = "collective";
  thread.characters[0].appearances[1].kind = "individual";
  validateThread(thread);
});

test("an absent character kind is accepted, so threads built before the tag still load", () => {
  // makeThread carries no `kind` anywhere; the passing case above is the proof
  // that this test isn't just asserting the field is ignored.
  const thread = makeThread();
  assert.equal("kind" in thread.characters[0], false);
  validateThread(thread);
});

test("a character kind outside the enum is rejected with its path", () => {
  const thread = makeThread() as unknown as { characters: { kind: string }[] };
  thread.characters[0].kind = "group";
  expectFailure(() => validateThread(thread), "characters[0].kind");
});

test("an appearance kind outside the enum is rejected with its path", () => {
  const thread = makeThread() as unknown as { characters: { appearances: { kind: string }[] }[] };
  thread.characters[0].appearances[0].kind = "";
  expectFailure(() => validateThread(thread), "appearances[0].kind");
});

test("null event participant ids are allowed", () => {
  validateThread(makeThread());
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

// --- Non-negative index checks at every referenced site ---

test("negative appearance chapterIndex is rejected", () => {
  const thread = makeThread();
  thread.characters[0].appearances[0].chapterIndex = -1;
  expectFailure(() => validateThread(thread), "appearances[0].chapterIndex");
});

test("negative firstAppearedChapterIndex is rejected", () => {
  const thread = makeThread();
  thread.characters[0].firstAppearedChapterIndex = -1;
  expectFailure(() => validateThread(thread), "firstAppearedChapterIndex");
});

test("negative event chapterIndex is rejected", () => {
  const thread = makeThread();
  thread.events[0].chapterIndex = -3;
  expectFailure(() => validateThread(thread), "events[0].chapterIndex");
});

test("negative relationship statement chapterIndex is rejected", () => {
  const thread = makeThread();
  thread.relationships[0].history[0].chapterIndex = -1;
  expectFailure(() => validateThread(thread), "history[0].chapterIndex");
});

test("negative flattened conflict bound chapterIndex is rejected", () => {
  const thread = makeThread();
  thread.meta.conflictCount = 1;
  thread.conflicts = [
    {
      from: { chapterIndex: -1, value: "Red" },
      to: { chapterIndex: 2, value: "Green" },
      characterId: "hen",
      characterName: "Hen",
    },
  ];
  expectFailure(() => validateThread(thread), "conflicts[0].from.chapterIndex");
});

test("non-integer chapterIndex is rejected", () => {
  const thread = makeThread();
  thread.events[0].chapterIndex = 1.5;
  expectFailure(() => validateThread(thread), "events[0].chapterIndex");
});
