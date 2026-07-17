import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  deleteThread,
  exportBundle,
  getLastOpened,
  getPrefs,
  getThread,
  importBundle,
  listLibrary,
  parseBundle,
  putThread,
  resetDbForTests,
  setLastOpened,
  setPrefs,
} from "../src/lib/db";
import { ValidationError } from "../src/lib/validate";
import { makeThread } from "./fixtures";

function threadText(overrides: Parameters<typeof makeThread>[0] = {}) {
  return JSON.stringify(makeThread(overrides));
}

beforeEach(async () => {
  await resetDbForTests();
});

test("putThread → listLibrary → getThread roundtrip", async () => {
  const res = await putThread(threadText());
  assert.equal(res.slug, "test-book");
  assert.equal(res.replaced, false);

  const lib = await listLibrary();
  assert.equal(lib.length, 1);
  assert.equal(lib[0].title, "Test Book");
  assert.equal(lib[0].characterCount, 2);
  assert.equal(lib[0].eventCount, 2);
  // Summary must not carry the heavy verbatim text.
  assert.ok(!("threadJsonText" in lib[0]));

  const thread = await getThread("test-book");
  assert.equal(thread?.meta.slug, "test-book");
  assert.equal(thread?.characters.length, 2);
});

test("putThread rejects an invalid thread and writes nothing", async () => {
  await assert.rejects(() => putThread("{ not json"), ValidationError);
  assert.deepEqual(await listLibrary(), []);
});

test("re-import replaces by slug (one record, replaced=true)", async () => {
  await putThread(threadText());
  const res = await putThread(threadText());
  assert.equal(res.replaced, true);
  assert.equal((await listLibrary()).length, 1);
});

test("prefs get/set per book", async () => {
  assert.equal(await getPrefs("test-book"), undefined);
  await setPrefs({ slug: "test-book", chapterCap: 5, activeTab: "timeline" });
  const p = await getPrefs("test-book");
  assert.equal(p?.chapterCap, 5);
  assert.equal(p?.activeTab, "timeline");
});

test("lastOpened get/set/clear", async () => {
  assert.equal(await getLastOpened(), null);
  await setLastOpened("test-book");
  assert.equal(await getLastOpened(), "test-book");
  await setLastOpened(null);
  assert.equal(await getLastOpened(), null);
});

test("deleteThread removes the book, its prefs, and clears matching lastOpened", async () => {
  await putThread(threadText());
  await setPrefs({ slug: "test-book", chapterCap: 2, activeTab: "characters" });
  await setLastOpened("test-book");

  await deleteThread("test-book");

  assert.deepEqual(await listLibrary(), []);
  assert.equal(await getPrefs("test-book"), undefined);
  assert.equal(await getLastOpened(), null);
});

test("deleteThread leaves a non-matching lastOpened untouched", async () => {
  await putThread(threadText());
  await putThread(threadText({ meta: { ...makeThread().meta, slug: "other", bookTitle: "Other" } }));
  await setLastOpened("other");

  await deleteThread("test-book");
  assert.equal(await getLastOpened(), "other");
});

test("export → import roundtrip restores books and prefs", async () => {
  await putThread(threadText());
  await setPrefs({ slug: "test-book", chapterCap: 1, activeTab: "timeline" });
  await setLastOpened("test-book");

  const bundle = await exportBundle();

  await resetDbForTests(); // simulate a cleared browser
  assert.deepEqual(await listLibrary(), []);

  const { imported } = await importBundle(bundle);
  assert.equal(imported, 1);
  assert.equal((await listLibrary())[0].title, "Test Book");
  assert.equal((await getPrefs("test-book"))?.chapterCap, 1);
  assert.equal(await getLastOpened(), "test-book");
});

test("importBundle merges — a null lastOpenedSlug leaves an existing pointer intact", async () => {
  await putThread(threadText());
  await setLastOpened("test-book");
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    books: [{ slug: "test-book", threadJsonText: threadText() }],
    prefs: { lastOpenedSlug: null, perBook: {} },
  };
  await importBundle(bundle);
  assert.equal(await getLastOpened(), "test-book"); // still valid, kept
});

test("importBundle is atomic — a bad embedded thread aborts the whole import", async () => {
  const good = makeThread();
  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    books: [
      { slug: "test-book", threadJsonText: JSON.stringify(good) },
      { slug: "broken", threadJsonText: "{ not json" },
    ],
    prefs: { lastOpenedSlug: null, perBook: {} },
  };
  await assert.rejects(() => importBundle(bundle), ValidationError);
  // Nothing written — the valid book must not sneak in.
  assert.deepEqual(await listLibrary(), []);
});

test("parseBundle rejects a wrong version", () => {
  assert.throws(() => parseBundle({ version: 99, books: [] }), ValidationError);
});

test("parseBundle rejects a slug that disagrees with its thread", () => {
  const bundle = {
    version: 1,
    books: [{ slug: "mismatch", threadJsonText: threadText() }],
  };
  assert.throws(() => parseBundle(bundle), /disagrees/);
});

test("parseBundle drops prefs for books not in the bundle", () => {
  const bundle = {
    version: 1,
    books: [{ slug: "test-book", threadJsonText: threadText() }],
    prefs: {
      lastOpenedSlug: "ghost",
      perBook: { ghost: { chapterCap: 3, activeTab: "characters" } },
    },
  };
  const { prefs, lastOpenedSlug } = parseBundle(bundle);
  assert.deepEqual(prefs, []);
  assert.equal(lastOpenedSlug, null); // ghost isn't a bundled book
});
