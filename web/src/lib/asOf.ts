import type {
  CharacterRole,
  EventSignificance,
  MergedCharacter,
  Thread,
  TierConflict,
  ProgressionRegression,
} from "@pipeline/types";
import { ROLE_ORDER } from "./constants";

// Spoiler-safe "world as of chapter N" selectors — the chapter-cap engine.
//
// The thread's top-level character.name/description and relationship.current
// reflect the WHOLE book, so rendering them directly leaks the ending. Every
// selector here recomputes state from the historical records (appearances[],
// history[], events) filtered to chapterIndex <= cutoff, taking the latest
// survivor. Output is purpose-built DTOs that structurally exclude whole-book
// and future (> cutoff) fields — the UI never receives an ungated MergedX.

export interface ChapterRange {
  min: number;
  max: number;
}

export interface CharacterView {
  id: string;
  name: string; // latest surviving appearance name <= cutoff
  role: CharacterRole; // highest prominence seen <= cutoff
  description: string; // latest appearance description <= cutoff
  aliases: string[]; // cumulative union across appearances <= cutoff
  firstSeenChapterIndex: number;
}

export interface AppearanceView {
  chapterIndex: number;
  chapterTitle: string | null;
  name: string;
  description: string;
  role: CharacterRole;
  aliases: string[];
}

export interface ConflictView {
  key: string; // "Tier" for the built-in conflicts; the configured key otherwise
  from: { chapterIndex: number; value: string };
  to: { chapterIndex: number; value: string };
}

export interface CharacterDetailView extends CharacterView {
  appearances: AppearanceView[]; // <= cutoff, chronological
  conflicts: ConflictView[]; // both bounds <= cutoff
}

export interface EventView {
  chapterIndex: number;
  chapterTitle: string | null;
  summary: string;
  significance: EventSignificance;
  participants: { id: string | null; name: string }[];
}

export interface RelationshipView {
  id: string;
  otherId: string;
  otherName: string; // from the latest surviving statement <= cutoff
  type: string;
  description: string;
  chapterIndex: number;
  chapterTitle: string | null;
}

export interface RelationshipStatementView {
  chapterIndex: number;
  chapterTitle: string | null;
  type: string;
  description: string;
}

// Both-endpoint (undirected) view of a relationship for the graph: a/b follow
// the merged relationship's participantIds order, everything else follows the
// same latest-survivor rule as RelationshipView.
export interface RelationshipEdgeView {
  id: string;
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  type: string;
  description: string;
  chapterIndex: number;
  chapterTitle: string | null;
  history: RelationshipStatementView[]; // <= cutoff, chronological
}

export interface StatsView {
  characters: number;
  relationships: number;
  events: number;
}

function roleRank(role: CharacterRole): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

// The chapter span the thread actually references (front matter with no
// entities simply isn't in here). Returns null for a thread with no records.
// Visits every chapter-index-bearing field validateThread checks, so the range
// can't clip a thread whose extremal index lives only in a conflict bound or a
// relationship's `current` rather than in an appearance/history entry.
export function chapterRange(thread: Thread): ChapterRange | null {
  let min = Infinity;
  let max = -Infinity;
  const see = (n: number) => {
    if (n < min) min = n;
    if (n > max) max = n;
  };
  const seeConflict = (c: TierConflict | ProgressionRegression) => {
    see(c.from.chapterIndex);
    see(c.to.chapterIndex);
  };
  for (const c of thread.characters) {
    see(c.firstAppearedChapterIndex);
    see(c.lastAppearedChapterIndex);
    for (const a of c.appearances) see(a.chapterIndex);
    for (const cf of c.conflicts) seeConflict(cf);
    for (const pr of c.progressionRegressions) seeConflict(pr);
  }
  for (const e of thread.events) see(e.chapterIndex);
  for (const r of thread.relationships) {
    see(r.current.chapterIndex);
    for (const s of r.history) see(s.chapterIndex);
  }
  for (const cf of thread.conflicts) seeConflict(cf);
  for (const pr of thread.progressionRegressions) seeConflict(pr);
  if (min === Infinity) return null;
  return { min, max };
}

// index -> title (for chapters at or before the cap), from whichever inline
// chapterTitle the thread carries for that index. A chapter title can itself
// be a spoiler ("The Death of X"), so titles past the cutoff are deliberately
// withheld — callers label those positions generically ("Chapter N").
export function chapterTitleMap(thread: Thread, cutoff: number): Map<number, string> {
  const map = new Map<number, string>();
  const put = (i: number, t: string | null) => {
    if (i <= cutoff && t !== null && !map.has(i)) map.set(i, t);
  };
  for (const c of thread.characters) {
    for (const a of c.appearances) put(a.chapterIndex, a.chapterTitle);
  }
  for (const e of thread.events) put(e.chapterIndex, e.chapterTitle);
  for (const r of thread.relationships) {
    for (const s of r.history) put(s.chapterIndex, s.chapterTitle);
  }
  return map;
}

// Resolve the effective cap from ordered candidates (e.g. [urlUpto, savedCap]).
// A candidate is honored only if it's an integer within the range; anything
// malformed / fractional / out-of-range falls through. The final fallback is
// range.min — the FIRST covered chapter — so a first open never reveals the
// whole book.
export function resolveCap(
  candidates: Array<number | null | undefined>,
  range: ChapterRange
): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c >= range.min && c <= range.max) {
      return c;
    }
  }
  return range.min;
}

// Latest appearance at or before the cutoff, or null if the character hasn't
// appeared yet.
function survivingAppearances(character: MergedCharacter, cutoff: number) {
  return character.appearances
    .filter((a) => a.chapterIndex <= cutoff)
    .sort((a, b) => a.chapterIndex - b.chapterIndex);
}

function toCharacterView(character: MergedCharacter, cutoff: number): CharacterView | null {
  const seen = survivingAppearances(character, cutoff);
  if (seen.length === 0) return null;
  const latest = seen[seen.length - 1];
  const aliases = [...new Set(seen.flatMap((a) => a.aliases))];
  const bestRole = seen.reduce<CharacterRole>(
    (best, a) => (roleRank(a.role) < roleRank(best) ? a.role : best),
    seen[0].role
  );
  return {
    id: character.id,
    name: latest.name,
    role: bestRole,
    description: latest.description,
    aliases,
    firstSeenChapterIndex: seen[0].chapterIndex,
  };
}

export function charactersAsOf(thread: Thread, cutoff: number): CharacterView[] {
  return thread.characters
    .map((c) => toCharacterView(c, cutoff))
    .filter((v): v is CharacterView => v !== null)
    .sort(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) ||
        a.firstSeenChapterIndex - b.firstSeenChapterIndex ||
        a.name.localeCompare(b.name)
    );
}

function conflictView(c: TierConflict, key: string): ConflictView {
  return { key, from: { ...c.from }, to: { ...c.to } };
}

export function characterAsOf(thread: Thread, cutoff: number, id: string): CharacterDetailView | null {
  const character = thread.characters.find((c) => c.id === id);
  if (!character) return null;
  const base = toCharacterView(character, cutoff);
  if (!base) return null;
  const seen = survivingAppearances(character, cutoff);
  const appearances: AppearanceView[] = seen.map((a) => ({
    chapterIndex: a.chapterIndex,
    chapterTitle: a.chapterTitle,
    name: a.name,
    description: a.description,
    role: a.role,
    aliases: a.aliases,
  }));
  // A conflict is only knowable once BOTH of its endpoints are within view.
  const inView = (c: TierConflict | ProgressionRegression) =>
    c.from.chapterIndex <= cutoff && c.to.chapterIndex <= cutoff;
  const conflicts: ConflictView[] = [
    ...character.conflicts.filter(inView).map((c) => conflictView(c, "Tier")),
    ...character.progressionRegressions.filter(inView).map((c) => conflictView(c, c.key)),
  ];
  return { ...base, appearances, conflicts };
}

export function relationshipsForCharacterAsOf(
  thread: Thread,
  cutoff: number,
  id: string
): RelationshipView[] {
  const views: RelationshipView[] = [];
  for (const r of thread.relationships) {
    if (!r.participantIds.includes(id)) continue;
    const survivors = r.history
      .filter((s) => s.chapterIndex <= cutoff)
      .sort((a, b) => a.chapterIndex - b.chapterIndex);
    if (survivors.length === 0) continue;
    const latest = survivors[survivors.length - 1];
    const otherId = r.participantIds.find((p) => p !== id) ?? id;
    const otherName = latest.fromId === otherId ? latest.fromName : latest.toName;
    views.push({
      id: r.id,
      otherId,
      otherName,
      type: latest.type,
      description: latest.description,
      chapterIndex: latest.chapterIndex,
      chapterTitle: latest.chapterTitle,
    });
  }
  return views.sort((a, b) => a.otherName.localeCompare(b.otherName));
}

// Every relationship with at least one statement at or before the cutoff,
// with both endpoints resolved. Sorted by id so output is deterministic
// regardless of the thread's relationship order.
export function relationshipEdgesAsOf(thread: Thread, cutoff: number): RelationshipEdgeView[] {
  const views: RelationshipEdgeView[] = [];
  for (const r of thread.relationships) {
    const survivors = r.history
      .filter((s) => s.chapterIndex <= cutoff)
      .sort((a, b) => a.chapterIndex - b.chapterIndex);
    if (survivors.length === 0) continue;
    const latest = survivors[survivors.length - 1];
    const [aId, bId] = r.participantIds;
    views.push({
      id: r.id,
      aId,
      aName: latest.fromId === aId ? latest.fromName : latest.toName,
      bId,
      bName: latest.fromId === bId ? latest.fromName : latest.toName,
      type: latest.type,
      description: latest.description,
      chapterIndex: latest.chapterIndex,
      chapterTitle: latest.chapterTitle,
      history: survivors.map((s) => ({
        chapterIndex: s.chapterIndex,
        chapterTitle: s.chapterTitle,
        type: s.type,
        description: s.description,
      })),
    });
  }
  return views.sort((a, b) => a.id.localeCompare(b.id));
}

function eventView(e: Thread["events"][number]): EventView {
  return {
    chapterIndex: e.chapterIndex,
    chapterTitle: e.chapterTitle,
    summary: e.summary,
    significance: e.significance,
    participants: e.charactersInvolved.map((ci) => ({ id: ci.id, name: ci.name })),
  };
}

export function eventsAsOf(thread: Thread, cutoff: number): EventView[] {
  return thread.events
    .filter((e) => e.chapterIndex <= cutoff)
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
    .map(eventView);
}

export function eventsForCharacterAsOf(thread: Thread, cutoff: number, id: string): EventView[] {
  return thread.events
    .filter((e) => e.chapterIndex <= cutoff && e.charactersInvolved.some((ci) => ci.id === id))
    .sort((a, b) => a.chapterIndex - b.chapterIndex)
    .map(eventView);
}

export function statsAsOf(thread: Thread, cutoff: number): StatsView {
  const characters = charactersAsOf(thread, cutoff).length;
  const relationships = thread.relationships.filter((r) =>
    r.history.some((s) => s.chapterIndex <= cutoff)
  ).length;
  const events = thread.events.filter((e) => e.chapterIndex <= cutoff).length;
  return { characters, relationships, events };
}
