import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chapterRange,
  chapterTitleMap,
  characterAsOf,
  charactersAsOf,
  eventsAsOf,
  eventsForCharacterAsOf,
  relationshipsForCharacterAsOf,
  resolveCap,
  statsAsOf,
} from "../src/lib/asOf";
import { makeThread } from "./fixtures";

const RANGE = { min: 1, max: 2 };

test("chapterRange spans the referenced indices", () => {
  assert.deepEqual(chapterRange(makeThread()), { min: 1, max: 2 });
});

test("chapterRange is null for a thread with no records", () => {
  const empty = makeThread({
    characters: [],
    relationships: [],
    events: [],
  });
  empty.meta.characterCount = 0;
  empty.meta.relationshipCount = 0;
  empty.meta.eventCount = 0;
  assert.equal(chapterRange(empty), null);
});

test("chapterTitleMap maps index to inline title up to the cutoff", () => {
  const map = chapterTitleMap(makeThread(), 2);
  assert.equal(map.get(1), "Chapter 1");
  assert.equal(map.get(2), "Chapter 2");
});

test("chapterTitleMap withholds titles past the cutoff (they can be spoilers)", () => {
  const thread = makeThread();
  // A revealing future chapter title must not leak below its own chapter.
  thread.events[1].chapterTitle = "The Betrayal of Mara";
  const map = chapterTitleMap(thread, 1);
  assert.equal(map.get(1), "Chapter 1");
  assert.equal(map.has(2), false); // ch2 title withheld at cutoff 1
});

test("chapterRange includes indices that live only in conflict bounds", () => {
  const thread = makeThread();
  // A conflict whose upper bound (5) exceeds any appearance/event/history index.
  thread.characters[0].conflicts = [
    { from: { chapterIndex: 1, value: "Red" }, to: { chapterIndex: 5, value: "Green" } },
  ];
  assert.deepEqual(chapterRange(thread), { min: 1, max: 5 });
});

test("resolveCap honors a valid candidate, else falls through to range.min", () => {
  assert.equal(resolveCap([2], RANGE), 2);
  assert.equal(resolveCap([undefined, 2], RANGE), 2); // second candidate
  assert.equal(resolveCap([5], RANGE), 1); // oversized -> falls through -> min
  assert.equal(resolveCap([0], RANGE), 1); // below min -> falls through
  assert.equal(resolveCap([1.5], RANGE), 1); // fractional -> falls through
  assert.equal(resolveCap([null, undefined], RANGE), 1); // nothing valid -> default min
});

test("charactersAsOf is empty before the first appearance", () => {
  assert.deepEqual(charactersAsOf(makeThread(), 0), []);
});

test("charactersAsOf uses the as-of name, not the whole-book name", () => {
  const at1 = charactersAsOf(makeThread(), 1);
  const hen = at1.find((c) => c.id === "hen");
  assert.equal(hen?.name, "Hen"); // NOT "Hen Ashworth"
  assert.equal(hen?.description, "A young potter."); // NOT the whole-book description

  const at2 = charactersAsOf(makeThread(), 2);
  assert.equal(at2.find((c) => c.id === "hen")?.name, "Hen Ashworth");
});

test("CharacterView structurally excludes whole-book and future fields", () => {
  const hen = charactersAsOf(makeThread(), 2).find((c) => c.id === "hen")!;
  assert.deepEqual(
    Object.keys(hen).sort(),
    ["aliases", "description", "firstSeenChapterIndex", "id", "name", "role"]
  );
});

test("aliases are the cumulative union of appearances <= cutoff", () => {
  const thread = makeThread();
  thread.characters[0].appearances[0].aliases = ["kid"];
  thread.characters[0].appearances[1].aliases = ["the potter"];
  const hen = charactersAsOf(thread, 2).find((c) => c.id === "hen")!;
  assert.deepEqual(hen.aliases.sort(), ["kid", "the potter"]);
});

test("role is the highest prominence seen <= cutoff", () => {
  const thread = makeThread();
  // Mara appears supporting at ch1, then only "mentioned" at ch2.
  thread.characters[1].appearances.push({
    chapterIndex: 2,
    chapterTitle: "Chapter 2",
    name: "Mara",
    aliases: [],
    description: "Mentioned in passing.",
    role: "mentioned",
  });
  thread.characters[1].lastAppearedChapterIndex = 2;
  const mara = charactersAsOf(thread, 2).find((c) => c.id === "mara")!;
  assert.equal(mara.role, "supporting"); // not demoted to "mentioned"
});

test("characterAsOf returns appearances only up to the cutoff", () => {
  assert.equal(characterAsOf(makeThread(), 1, "hen")?.appearances.length, 1);
  assert.equal(characterAsOf(makeThread(), 2, "hen")?.appearances.length, 2);
  assert.equal(characterAsOf(makeThread(), 0, "hen"), null);
});

test("characterAsOf shows a conflict only once both bounds are within view", () => {
  const thread = makeThread();
  thread.characters[0].conflicts = [
    { from: { chapterIndex: 1, value: "Red" }, to: { chapterIndex: 2, value: "Green" } },
  ];
  assert.equal(characterAsOf(thread, 1, "hen")?.conflicts.length, 0); // to-bound (2) not yet seen
  const at2 = characterAsOf(thread, 2, "hen");
  assert.equal(at2?.conflicts.length, 1);
  assert.equal(at2?.conflicts[0].key, "Tier");
});

test("relationships are hidden until the first statement", () => {
  assert.deepEqual(relationshipsForCharacterAsOf(makeThread(), 0, "hen"), []);
});

test("relationshipsForCharacterAsOf uses the latest surviving statement", () => {
  const at1 = relationshipsForCharacterAsOf(makeThread(), 1, "hen");
  assert.equal(at1.length, 1);
  assert.equal(at1[0].otherId, "mara");
  assert.equal(at1[0].otherName, "Mara");
  assert.equal(at1[0].description, "Just met.");

  const at2 = relationshipsForCharacterAsOf(makeThread(), 2, "hen");
  assert.equal(at2[0].description, "Fast friends.");
});

test("eventsAsOf filters to the cutoff and preserves null participant ids", () => {
  assert.equal(eventsAsOf(makeThread(), 1).length, 1);
  const at2 = eventsAsOf(makeThread(), 2);
  assert.equal(at2.length, 2);
  const stranger = at2[1].participants[0];
  assert.equal(stranger.id, null); // UI must render this as plain text, never a link
  assert.equal(stranger.name, "the stranger");
});

test("eventsForCharacterAsOf matches by participant id", () => {
  // Hen is in the ch1 event but not the ch2 (stranger-only) event.
  assert.equal(eventsForCharacterAsOf(makeThread(), 2, "hen").length, 1);
});

test("statsAsOf counts only visible entities", () => {
  assert.deepEqual(statsAsOf(makeThread(), 0), { characters: 0, relationships: 0, events: 0 });
  assert.deepEqual(statsAsOf(makeThread(), 1), { characters: 2, relationships: 1, events: 1 });
  assert.deepEqual(statsAsOf(makeThread(), 2), { characters: 2, relationships: 1, events: 2 });
});
