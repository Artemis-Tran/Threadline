import type { EventSignificance } from "@pipeline/types";
import type { CharacterView, EventView } from "./asOf";
import { ROLE_ORDER } from "./constants";

// Pure layout engine for the Timeline story map. No DOM, no React — the
// component maps the per-row lane orders this module emits onto x coordinates
// and draws the weaving lane paths. Two separate passes build the orders:
//   1. greedyOrders — top-down block-pull. Invariants (tested): each row's
//      participants are contiguous, non-participants keep their relative order
//      from row to row, and a row's order depends only on rows above it.
//   2. refineCrossings — bounded adjacent-transposition sweeps that only apply
//      strictly crossing-reducing swaps. May reorder non-participants (its
//      invariants are weaker: contiguity preserved, crossings never increase,
//      deterministic output).

export const MAX_LANES = 5;

// Vertical geometry (px). The component owns horizontal spacing.
export const STORY_MAP_GEOMETRY = {
  top: 86, // headroom for the rotated lane name labels
  rowHeight: 56,
  stationOffset: 20, // station center below the row's top edge
  chapterPad: 14,
  chapterHead: 30,
  moreHeight: 30, // "+N more" pill row
  bottom: 26,
} as const;

function roleRank(role: CharacterView["role"]): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

// Default lanes: POV + major characters visible at the cap, in the same
// role → first appearance → name order the Characters tab uses, capped at
// MAX_LANES (the palette size). Re-sorted internally so callers needn't
// pre-sort.
export function autoLaneIds(characters: readonly CharacterView[]): string[] {
  return characters
    .filter((c) => c.role === "pov" || c.role === "major")
    .sort(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) ||
        a.firstSeenChapterIndex - b.firstSeenChapterIndex ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, MAX_LANES)
    .map((c) => c.id);
}

// Palette slots (1..MAX_LANES). Color follows the entity: a lane keeps its
// slot for as long as it stays active, and newcomers take the lowest free
// slot — removing one lane never repaints the others.
export function assignSlots(
  activeIds: readonly string[],
  prev: ReadonlyMap<string, number>
): Map<string, number> {
  const next = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of activeIds) {
    const slot = prev.get(id);
    if (slot !== undefined && slot >= 1 && slot <= MAX_LANES && !taken.has(slot)) {
      next.set(id, slot);
      taken.add(slot);
    }
  }
  for (const id of activeIds) {
    if (next.has(id)) continue;
    for (let slot = 1; slot <= MAX_LANES; slot++) {
      if (!taken.has(slot)) {
        next.set(id, slot);
        taken.add(slot);
        break;
      }
    }
  }
  return next;
}

export interface StoryMapOptions {
  visibleSignificance: ReadonlySet<EventSignificance>;
  revealedChapters: ReadonlySet<number>;
}

export interface StoryMapRow {
  eventIndex: number; // index into the input events array — the stable identity
  event: EventView;
  y: number; // station center
  order: readonly string[]; // lane ids left-to-right at this row
  lanedParticipantIds: readonly string[];
}

export interface StoryMapChapterMark {
  chapterIndex: number;
  chapterTitle: string | null;
  y: number;
  hiddenCount: number;
  moreY: number | null; // y of the "+N more" pill, null when nothing is hidden
}

export interface StoryMapLayout {
  rows: StoryMapRow[];
  chapterMarks: StoryMapChapterMark[];
  firstOrder: readonly string[];
  lastOrder: readonly string[];
  totalHeight: number;
}

// The greedy block-pull pass. Input is just the per-row laned-participant
// sets (in row order); output is the lane order at every row. Rows with fewer
// than two participants leave the order untouched.
export function greedyOrders(
  participantSets: readonly (readonly string[])[],
  laneIds: readonly string[]
): string[][] {
  let order = [...laneIds];
  const result: string[][] = [];
  for (const parts of participantSets) {
    const inParts = new Set(parts);
    if (inParts.size >= 2) {
      const block = order.filter((id) => inParts.has(id));
      const rest = order.filter((id) => !inParts.has(id));
      const mean =
        block.reduce((sum, id) => sum + order.indexOf(id), 0) / block.length;
      const at = Math.max(0, Math.min(rest.length, Math.round(mean - (block.length - 1) / 2)));
      order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    }
    result.push([...order]);
  }
  return result;
}

// Total lane crossings between consecutive rows: a pair of lanes crosses when
// their left-to-right order flips from one row to the next.
export function countCrossings(orders: readonly (readonly string[])[]): number {
  let crossings = 0;
  for (let i = 1; i < orders.length; i++) {
    const prevPos = new Map(orders[i - 1].map((id, p) => [id, p]));
    const cur = orders[i];
    for (let a = 0; a < cur.length; a++) {
      for (let b = a + 1; b < cur.length; b++) {
        const pa = prevPos.get(cur[a]);
        const pb = prevPos.get(cur[b]);
        if (pa !== undefined && pb !== undefined && pa > pb) crossings++;
      }
    }
  }
  return crossings;
}

function crossingsBetween(a: readonly string[], b: readonly string[]): number {
  return countCrossings([a, b]);
}

// Bounded refinement: sweep the rows in order, trying adjacent transpositions
// that strictly reduce the local crossing count (against the neighboring rows
// only). A swap is allowed only when it cannot break participant contiguity:
// both lanes inside the row's block, or both outside it. Deterministic — fixed
// iteration order, strict improvement only. Returns new arrays.
export function refineCrossings(
  orders: readonly (readonly string[])[],
  participantSets: readonly (readonly string[])[],
  maxSweeps = 4
): string[][] {
  const rows = orders.map((o) => [...o]);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let improved = false;
    for (let i = 0; i < rows.length; i++) {
      const inParts = new Set(participantSets[i] ?? []);
      const above = i > 0 ? rows[i - 1] : null;
      const below = i + 1 < rows.length ? rows[i + 1] : null;
      for (let k = 0; k + 1 < rows[i].length; k++) {
        const x = rows[i][k];
        const y = rows[i][k + 1];
        if (inParts.size >= 2 && inParts.has(x) !== inParts.has(y)) continue;
        const before =
          (above ? crossingsBetween(above, rows[i]) : 0) +
          (below ? crossingsBetween(rows[i], below) : 0);
        rows[i][k] = y;
        rows[i][k + 1] = x;
        const after =
          (above ? crossingsBetween(above, rows[i]) : 0) +
          (below ? crossingsBetween(rows[i], below) : 0);
        if (after < before) {
          improved = true;
        } else {
          rows[i][k] = x;
          rows[i][k + 1] = y;
        }
      }
    }
    if (!improved) break;
  }
  return rows;
}

function isVisible(e: EventView, opts: StoryMapOptions): boolean {
  return opts.visibleSignificance.has(e.significance) || opts.revealedChapters.has(e.chapterIndex);
}

function lanedParticipants(e: EventView, lanes: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const p of e.participants) {
    if (p.id !== null && lanes.has(p.id)) seen.add(p.id);
  }
  return [...seen];
}

// Full layout: greedy pass + refinement + vertical geometry. `events` must be
// the cap-filtered, chapter-sorted eventsAsOf output — eventIndex identities
// are positions in that array. Chapters whose events are all hidden still get
// a mark (with a "+N more" position) so the reveal affordance exists.
export function buildStoryMap(
  events: readonly EventView[],
  laneIds: readonly string[],
  opts: StoryMapOptions
): StoryMapLayout {
  const laneSet = new Set(laneIds);
  const G = STORY_MAP_GEOMETRY;

  // Sequential chapter grouping (same shape as the list view's).
  interface Group {
    chapterIndex: number;
    chapterTitle: string | null;
    entries: { event: EventView; eventIndex: number }[];
  }
  const groups: Group[] = [];
  for (const [eventIndex, event] of events.entries()) {
    const last = groups[groups.length - 1];
    if (last && last.chapterIndex === event.chapterIndex) {
      last.entries.push({ event, eventIndex });
    } else {
      groups.push({ chapterIndex: event.chapterIndex, chapterTitle: event.chapterTitle, entries: [{ event, eventIndex }] });
    }
  }

  const visibleEntries = groups.flatMap((g) => g.entries.filter((en) => isVisible(en.event, opts)));
  const participantSets = visibleEntries.map((en) => lanedParticipants(en.event, laneSet));
  const orders = refineCrossings(greedyOrders(participantSets, laneIds), participantSets);

  const rows: StoryMapRow[] = [];
  const chapterMarks: StoryMapChapterMark[] = [];
  let y = G.top;
  let rowIdx = 0;
  for (const g of groups) {
    const visible = g.entries.filter((en) => isVisible(en.event, opts));
    const hiddenCount = g.entries.length - visible.length;
    if (visible.length === 0 && hiddenCount === 0) continue;
    y += G.chapterPad;
    const markY = y;
    y += G.chapterHead;
    for (const en of visible) {
      rows.push({
        eventIndex: en.eventIndex,
        event: en.event,
        y: y + G.stationOffset,
        order: orders[rowIdx],
        lanedParticipantIds: participantSets[rowIdx],
      });
      rowIdx++;
      y += G.rowHeight;
    }
    let moreY: number | null = null;
    if (hiddenCount > 0) {
      moreY = y;
      y += G.moreHeight;
    }
    chapterMarks.push({ chapterIndex: g.chapterIndex, chapterTitle: g.chapterTitle, y: markY, hiddenCount, moreY });
  }

  return {
    rows,
    chapterMarks,
    firstOrder: rows.length > 0 ? rows[0].order : [...laneIds],
    lastOrder: rows.length > 0 ? rows[rows.length - 1].order : [...laneIds],
    totalHeight: y + G.bottom,
  };
}
