import { test } from "node:test";
import assert from "node:assert/strict";
import type { CharacterRole, EventSignificance } from "@pipeline/types";
import type { CharacterView, EventView } from "../src/lib/asOf";
import {
  MAX_LANES,
  assignSlots,
  autoLaneIds,
  buildStoryMap,
  countCrossings,
  greedyOrders,
  refineCrossings,
  type StoryMapOptions,
} from "../src/lib/storymap";

// --- fixtures ---

function char(id: string, role: CharacterRole, firstSeen = 1, name = id.toUpperCase()): CharacterView {
  return { id, name, role, description: "", aliases: [], firstSeenChapterIndex: firstSeen };
}

function ev(
  chapterIndex: number,
  significance: EventSignificance,
  participantIds: (string | null)[],
  summary = `ch${chapterIndex} ${significance}`
): EventView {
  return {
    chapterIndex,
    chapterTitle: `Chapter ${chapterIndex}`,
    summary,
    significance,
    participants: participantIds.map((id, i) => ({ id, name: id ?? `plain${i}` })),
  };
}

const ALL_SIGS: ReadonlySet<EventSignificance> = new Set(["major", "moderate", "minor"]);
const MAJOR_ONLY: ReadonlySet<EventSignificance> = new Set(["major"]);

function opts(
  visibleSignificance: ReadonlySet<EventSignificance> = ALL_SIGS,
  revealedChapters: ReadonlySet<number> = new Set()
): StoryMapOptions {
  return { visibleSignificance, revealedChapters };
}

// Contiguity: the row's participants occupy adjacent positions in its order.
function assertContiguous(order: readonly string[], parts: readonly string[]) {
  if (parts.length < 2) return;
  const idxs = parts.map((p) => order.indexOf(p)).sort((a, b) => a - b);
  assert.equal(idxs[0] >= 0, true, `participant missing from order ${order.join(",")}`);
  assert.equal(
    idxs[idxs.length - 1] - idxs[0],
    idxs.length - 1,
    `participants ${parts.join(",")} not contiguous in ${order.join(",")}`
  );
}

// --- autoLaneIds ---

test("autoLaneIds picks pov+major, ordered by role, first appearance, then name", () => {
  const characters = [
    char("m2", "major", 5, "Zed"),
    char("s1", "supporting", 1),
    char("p1", "pov", 3),
    char("m1", "major", 5, "Anna"),
    char("x1", "minor", 1),
    char("m3", "major", 2),
  ];
  assert.deepEqual(autoLaneIds(characters), ["p1", "m3", "m1", "m2"]);
});

test("autoLaneIds truncates to MAX_LANES", () => {
  const characters = [
    char("p1", "pov", 1),
    char("p2", "pov", 2),
    char("m1", "major", 1),
    char("m2", "major", 2),
    char("m3", "major", 3),
    char("m4", "major", 4),
    char("m5", "major", 5),
  ];
  const lanes = autoLaneIds(characters);
  assert.equal(lanes.length, MAX_LANES);
  assert.deepEqual(lanes, ["p1", "p2", "m1", "m2", "m3"]);
});

test("autoLaneIds is caller-order independent", () => {
  const characters = [char("p1", "pov", 3), char("m1", "major", 1)];
  assert.deepEqual(autoLaneIds(characters), autoLaneIds([...characters].reverse()));
});

// --- assignSlots ---

test("assignSlots keeps survivors' slots when a lane is removed", () => {
  const first = assignSlots(["a", "b", "c"], new Map());
  assert.deepEqual([...first.entries()], [["a", 1], ["b", 2], ["c", 3]]);
  const afterRemove = assignSlots(["a", "c"], first);
  assert.equal(afterRemove.get("a"), 1);
  assert.equal(afterRemove.get("c"), 3);
});

test("assignSlots gives a newcomer the lowest free slot", () => {
  const prev = assignSlots(["a", "b", "c"], new Map());
  const next = assignSlots(["a", "c", "d"], prev); // b removed → slot 2 free
  assert.equal(next.get("d"), 2);
  assert.equal(next.get("a"), 1);
  assert.equal(next.get("c"), 3);
});

// --- greedyOrders ---

const LANES = ["a", "b", "c", "d", "e"];

test("greedy: participants become contiguous on every row", () => {
  const sets = [["a", "d"], ["b", "e"], ["a", "c", "e"], ["d", "b"]];
  const orders = greedyOrders(sets, LANES);
  assert.equal(orders.length, sets.length);
  orders.forEach((order, i) => assertContiguous(order, sets[i]));
});

test("greedy: non-participants preserve relative order step to step", () => {
  const sets = [["a", "d"], ["b", "e"], ["c", "a"]];
  const orders = greedyOrders(sets, LANES);
  let prev: readonly string[] = LANES;
  orders.forEach((order, i) => {
    const parts = new Set(sets[i]);
    const restBefore = prev.filter((id) => !parts.has(id));
    const restAfter = order.filter((id) => !parts.has(id));
    assert.deepEqual(restAfter, restBefore, `row ${i} reordered non-participants`);
    prev = order;
  });
});

test("greedy: rows with <2 participants leave the order unchanged", () => {
  const orders = greedyOrders([["a"], [], ["b", "d"]], LANES);
  assert.deepEqual(orders[0], LANES);
  assert.deepEqual(orders[1], LANES);
});

test("greedy: top-down locality — a later row cannot change earlier rows", () => {
  const sets = [["a", "e"], ["b", "d"]];
  const long = greedyOrders([...sets, ["c", "e"]], LANES);
  const short = greedyOrders(sets, LANES);
  assert.deepEqual(long.slice(0, 2), short);
});

// --- countCrossings / refineCrossings ---

test("countCrossings counts order inversions between consecutive rows", () => {
  assert.equal(countCrossings([["a", "b", "c"], ["a", "b", "c"]]), 0);
  assert.equal(countCrossings([["a", "b", "c"], ["b", "a", "c"]]), 1);
  assert.equal(countCrossings([["a", "b", "c"], ["c", "b", "a"]]), 3);
  assert.equal(countCrossings([["a", "b"], ["b", "a"], ["a", "b"]]), 2);
});

test("refine: never increases crossings and is deterministic", () => {
  const sets = [["a", "e"], ["c", "d"], ["a", "b"], ["d", "e"], ["b", "c"]];
  const greedy = greedyOrders(sets, LANES);
  const refined1 = refineCrossings(greedy, sets);
  const refined2 = refineCrossings(greedy, sets);
  assert.equal(countCrossings(refined1) <= countCrossings(greedy), true);
  assert.deepEqual(refined1, refined2);
});

test("refine: preserves participant contiguity", () => {
  const sets = [["a", "e"], ["c", "d"], ["a", "b"], ["d", "e"], ["b", "c"]];
  const refined = refineCrossings(greedyOrders(sets, LANES), sets);
  refined.forEach((order, i) => assertContiguous(order, sets[i]));
});

test("refine: does not mutate its input", () => {
  const sets = [["a", "e"], ["b", "d"]];
  const greedy = greedyOrders(sets, LANES);
  const snapshot = greedy.map((o) => [...o]);
  refineCrossings(greedy, sets);
  assert.deepEqual(greedy, snapshot);
});

test("refine: removes a gratuitous inversion the greedy pass cannot see", () => {
  // Hand-built orders with an avoidable zigzag on a no-participant row.
  const orders = [
    ["a", "b", "c"],
    ["b", "a", "c"],
    ["a", "b", "c"],
  ];
  const refined = refineCrossings(orders, [[], [], []]);
  assert.equal(countCrossings(refined) < countCrossings(orders), true);
});

// --- buildStoryMap ---

test("buildStoryMap: majors-only default hides others but counts them per chapter", () => {
  const events = [
    ev(1, "major", ["a", "b"]),
    ev(1, "minor", ["c"]),
    ev(2, "moderate", ["a", "c"]),
    ev(3, "major", ["b", "c"]),
  ];
  const layout = buildStoryMap(events, LANES, opts(MAJOR_ONLY));
  assert.deepEqual(layout.rows.map((r) => r.eventIndex), [0, 3]);
  const byCh = new Map(layout.chapterMarks.map((m) => [m.chapterIndex, m]));
  assert.equal(byCh.get(1)?.hiddenCount, 1);
  assert.equal(byCh.get(2)?.hiddenCount, 1);
  assert.equal(byCh.get(3)?.hiddenCount, 0);
  assert.equal(byCh.get(3)?.moreY, null);
});

test("buildStoryMap: a hidden-only chapter still gets a mark with a moreY", () => {
  const events = [ev(1, "major", ["a"]), ev(2, "minor", ["b"]), ev(3, "major", ["c"])];
  const layout = buildStoryMap(events, LANES, opts(MAJOR_ONLY));
  const ch2 = layout.chapterMarks.find((m) => m.chapterIndex === 2);
  assert.notEqual(ch2, undefined);
  assert.equal(ch2?.hiddenCount, 1);
  assert.equal(typeof ch2?.moreY, "number");
  assert.equal(layout.rows.some((r) => r.event.chapterIndex === 2), false);
});

test("buildStoryMap: revealing a chapter surfaces its hidden events", () => {
  const events = [ev(1, "major", ["a"]), ev(2, "minor", ["b"]), ev(2, "moderate", ["c"])];
  const layout = buildStoryMap(events, LANES, opts(MAJOR_ONLY, new Set([2])));
  assert.deepEqual(layout.rows.map((r) => r.eventIndex), [0, 1, 2]);
  const ch2 = layout.chapterMarks.find((m) => m.chapterIndex === 2);
  assert.equal(ch2?.hiddenCount, 0);
  assert.equal(ch2?.moreY, null);
});

test("buildStoryMap: eventIndex is stable as the cap grows (prefix identity)", () => {
  const events = [ev(1, "major", ["a"]), ev(2, "major", ["b"]), ev(3, "major", ["c"])];
  const short = buildStoryMap(events.slice(0, 2), LANES, opts());
  const long = buildStoryMap(events, LANES, opts());
  assert.deepEqual(
    short.rows.map((r) => [r.eventIndex, r.event.summary]),
    long.rows.slice(0, 2).map((r) => [r.eventIndex, r.event.summary])
  );
});

test("buildStoryMap: null-id and unlaned participants never join a lane block", () => {
  const events = [ev(1, "major", [null, "zz", "a"])]; // zz is not a lane
  const layout = buildStoryMap(events, LANES, opts());
  assert.deepEqual(layout.rows[0].lanedParticipantIds, ["a"]);
});

test("buildStoryMap: an event with no laned participants is an orphan row (empty block)", () => {
  const events = [ev(1, "major", [null]), ev(2, "major", ["zz"])];
  const layout = buildStoryMap(events, LANES, opts());
  assert.equal(layout.rows.length, 2);
  for (const r of layout.rows) assert.deepEqual(r.lanedParticipantIds, []);
});

test("buildStoryMap: duplicate participant entries collapse to one lane id", () => {
  const events = [ev(1, "major", ["a", "a", "b"])];
  const layout = buildStoryMap(events, LANES, opts());
  assert.deepEqual([...layout.rows[0].lanedParticipantIds].sort(), ["a", "b"]);
});

test("buildStoryMap: rows are contiguity-safe after composition", () => {
  const events = [
    ev(1, "major", ["a", "d"]),
    ev(2, "major", ["b", "e"]),
    ev(2, "major", ["a", "c", "e"]),
    ev(4, "major", ["d", "b"]),
  ];
  const layout = buildStoryMap(events, LANES, opts());
  for (const r of layout.rows) assertContiguous(r.order, r.lanedParticipantIds);
});

test("buildStoryMap: y positions strictly increase and totalHeight bounds them", () => {
  const events = [ev(1, "major", ["a"]), ev(1, "minor", ["b"]), ev(2, "moderate", ["c"])];
  const layout = buildStoryMap(events, LANES, opts());
  let prev = 0;
  for (const r of layout.rows) {
    assert.equal(r.y > prev, true);
    prev = r.y;
  }
  assert.equal(layout.totalHeight > prev, true);
  for (const m of layout.chapterMarks) assert.equal(m.y < layout.totalHeight, true);
});

test("buildStoryMap: empty events and empty lanes are safe", () => {
  const empty = buildStoryMap([], LANES, opts());
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.chapterMarks, []);
  assert.deepEqual([...empty.firstOrder], LANES);

  const noLanes = buildStoryMap([ev(1, "major", ["a", "b"])], [], opts());
  assert.equal(noLanes.rows.length, 1);
  assert.deepEqual([...noLanes.rows[0].order], []);
  assert.deepEqual(noLanes.rows[0].lanedParticipantIds, []);
});
