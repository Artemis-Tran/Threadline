import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db";
import { getBook, getChapter, getChapterList, getThreadJson, importBook, listBooks } from "../src/lib/repo";
import { makeParsedBook, makeThread } from "./fixtures";

function importFixture(db: ReturnType<typeof openDb>) {
  const parsed = makeParsedBook();
  const thread = makeThread();
  const threadText = JSON.stringify(thread);
  const result = importBook(db, parsed, thread, threadText);
  return { parsed, thread, threadText, result };
}

test("import → list → read roundtrip", () => {
  const db = openDb(":memory:");
  const { threadText, result } = importFixture(db);

  assert.equal(result.slug, "test-book");
  assert.equal(result.replaced, false);

  const books = listBooks(db);
  assert.equal(books.length, 1);
  assert.equal(books[0].title, "Test Book");
  assert.equal(books[0].creator, "Test Author");
  assert.equal(books[0].chapterCount, 3);
  assert.equal(books[0].characterCount, 2);
  assert.equal(books[0].relationshipCount, 1);
  assert.equal(books[0].eventCount, 2);
  assert.equal(books[0].threadChapterCount, 2);

  const chapterList = getChapterList(db, "test-book");
  assert.deepEqual(
    chapterList.map((c) => c.index),
    [0, 1, 2]
  );
  assert.equal(chapterList[0].title, "Front Matter");

  const chapter = getChapter(db, "test-book", 1);
  assert.equal(chapter?.text, "Chapter one text.");
  assert.equal(chapter?.epubId, "p1");

  // Stored verbatim — what the client fetches is byte-identical to the upload.
  assert.equal(getThreadJson(db, "test-book"), threadText);
});

test("re-import replaces the book and its chapters cleanly", () => {
  const db = openDb(":memory:");
  importFixture(db);

  const parsed = makeParsedBook();
  parsed.chapters = parsed.chapters.slice(0, 2); // second upload dropped a chapter
  const thread = makeThread();
  thread.meta.eventCount = 1;
  thread.events = thread.events.slice(0, 1);
  const result = importBook(db, parsed, thread, JSON.stringify(thread));

  assert.equal(result.replaced, true);
  const books = listBooks(db);
  assert.equal(books.length, 1, "re-import must not create a second book");
  assert.equal(books[0].eventCount, 1);
  assert.deepEqual(
    getChapterList(db, "test-book").map((c) => c.index),
    [0, 1],
    "old chapters must be fully replaced"
  );
});

test("missing lookups return undefined", () => {
  const db = openDb(":memory:");
  assert.equal(getBook(db, "nope"), undefined);
  assert.equal(getChapter(db, "nope", 0), undefined);
  assert.equal(getThreadJson(db, "nope"), undefined);
  assert.deepEqual(getChapterList(db, "nope"), []);
});
