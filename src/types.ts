import * as path from "path";

// Shared data shapes for the extraction pipeline. parse-epub.ts produces
// ParsedBook; the extraction steps consume it. Keeping these in one place
// means a parser-side field change is a compile error in the consumers rather
// than a silent runtime `undefined`.

export interface ParsedChapter {
  index: number;
  id: string;
  href: string;
  title: string | null;
  wordCount: number;
  text: string;
}

export interface ParsedBook {
  sourceFile: string;
  title: string | null;
  creator: string | null;
  language: string | null;
  chapterCount: number;
  wordCount: number;
  chapters: ParsedChapter[];
}

export const CHARACTER_ROLES = ["pov", "major", "supporting", "minor", "mentioned"] as const;
export type CharacterRole = (typeof CHARACTER_ROLES)[number];

export const EVENT_SIGNIFICANCE = ["major", "moderate", "minor"] as const;
export type EventSignificance = (typeof EVENT_SIGNIFICANCE)[number];

// Whether a character entry stands for one entity or many. "Guild council" and
// "Dock workers" are collectives; everything else is an individual. The tag is
// optional everywhere it appears and ABSENT ALWAYS MEANS `individual`, so
// extracts and threads produced before the tag existed keep reading unchanged.
// The extraction schema nonetheless requires it (see EXTRACTION_SCHEMA in
// extract-book.ts) — optionality is a compatibility rule for data already on
// disk, not a licence for the model to skip the judgment.
export const CHARACTER_KINDS = ["individual", "collective"] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

export interface ExtractedCharacter {
  name: string;
  aliases: string[];
  description: string;
  role: CharacterRole;
  kind?: CharacterKind;
}

export interface ExtractedRelationship {
  from: string;
  to: string;
  type: string;
  description: string;
}

export interface ExtractedEvent {
  summary: string;
  characters_involved: string[];
  significance: EventSignificance;
}

export interface Extraction {
  characters: ExtractedCharacter[];
  relationships: ExtractedRelationship[];
  events: ExtractedEvent[];
}

// The extract step's (extract-book.ts) hint roster, persisted in manifest.json.
// Not authoritative — capped aliases, truncated descriptions, longest-string-wins
// merge. The merge step (merge-thread.ts) rebuilds its own full history from the
// chunk files directly rather than trusting this.
export interface RosterEntry {
  name: string;
  aliases: string[];
  description: string;
  firstAppearedChapterIndex: number;
  lastAppearedChapterIndex: number;
}

export type SkipReason = "word-count" | "title";

export interface ManifestChapterEntry {
  index: number;
  title: string | null;
  wordCount: number;
  status: "extracted" | "from-cache" | "pending" | `skipped:${SkipReason}`;
  file?: string;
}

export interface Manifest {
  meta: {
    model: string;
    parsedJsonPath: string;
    bookTitle: string | null;
    timestamp: string;
    complete: boolean;
    apiCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    actualCostUsd: number;
    rosterSize: number;
    // Set only when the run was started from a --roster file. Without it a
    // seeded run's manifest is indistinguishable from one whose roster was
    // built entirely by replaying chapter extracts.
    rosterPath?: string;
  };
  chapters: ManifestChapterEntry[];
  roster: RosterEntry[];
}

// --- Merge step (merge-thread.ts) output shapes ---

export interface CharacterAppearance {
  chapterIndex: number;
  chapterTitle: string | null;
  name: string;
  aliases: string[];
  description: string;
  role: CharacterRole;
  // Carried per-appearance the way `role` is, because chapter extracts are
  // per-chapter and chapters can disagree. The merged character's own `kind`
  // reconciles them; see resolveCharacterKind in merge-thread.ts.
  kind?: CharacterKind;
}

// Provisional, inferred solely from this book's "<Color> tier" phrasing — not
// derived from any authoritative source. Exported as a named constant
// specifically so it's trivial to override per-book later.
export const TIER_ORDER = ["Red", "Orange", "Yellow", "Green"] as const;
export type TierName = (typeof TIER_ORDER)[number];

// `value` is a string, not TierName: a --progression-order override of the
// "Tier" key can put its own vocabulary here (e.g. Bronze/Silver/Gold), so
// only the no-config default is guaranteed to stay within TIER_ORDER.
export interface TierConflict {
  from: { chapterIndex: number; value: string };
  to: { chapterIndex: number; value: string };
}

export interface FlattenedConflict extends TierConflict {
  characterId: string;
  characterName: string;
}

// A configurable, per-key analogue of TIER_ORDER: `descriptionPattern` is a
// regex template with a `{value}` placeholder (e.g. "{value}\\s+tier\\b"),
// substituted with `order.join("|")` to build the actual matcher. Tier's own
// entry (DEFAULT_PROGRESSION_ORDERS in merge-thread.ts) reproduces today's
// TIER_ORDER/TIER_REGEX behavior as data instead of hardcoded logic; any
// other key comes from an explicit, human-supplied config file — never
// inferred — so nothing is silently guessed at.
export interface ProgressionOrder {
  key: string;
  order: string[];
  descriptionPattern: string;
}

export interface ProgressionRegression {
  key: string;
  from: { chapterIndex: number; value: string };
  to: { chapterIndex: number; value: string };
}

export interface FlattenedProgressionRegression extends ProgressionRegression {
  characterId: string;
  characterName: string;
}

export interface MergedCharacter {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  // Reconciled from `appearances` by the merge step, and always written on a
  // freshly merged thread. Optional only so threads merged before the tag
  // existed stay valid — a reader treats absence as `individual`.
  kind?: CharacterKind;
  appearances: CharacterAppearance[];
  firstAppearedChapterIndex: number;
  lastAppearedChapterIndex: number;
  conflicts: TierConflict[];
  // Regressions for configured keys other than "Tier" — Tier's own
  // regressions stay in `conflicts` for backward compatibility; see
  // merge-thread.ts's detectTierConflicts/detectProgressionRegressions split.
  progressionRegressions: ProgressionRegression[];
}

export interface RelationshipStatement {
  chapterIndex: number;
  chapterTitle: string | null;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  type: string;
  description: string;
}

export interface MergedRelationship {
  id: string;
  participantIds: [string, string];
  current: RelationshipStatement;
  history: RelationshipStatement[];
}

export interface MergedEvent {
  chapterIndex: number;
  chapterTitle: string | null;
  summary: string;
  significance: EventSignificance;
  charactersInvolved: { id: string | null; name: string }[];
}

export interface ThreadMeta {
  bookTitle: string | null;
  slug: string;
  sourceManifest: string;
  generatedAt: string;
  chapterCount: number;
  characterCount: number;
  relationshipCount: number;
  eventCount: number;
  conflictCount: number;
  progressionRegressionCount: number;
  warningCount: number;
}

export interface Thread {
  meta: ThreadMeta;
  characters: MergedCharacter[];
  relationships: MergedRelationship[];
  events: MergedEvent[];
  conflicts: FlattenedConflict[];
  progressionRegressions: FlattenedProgressionRegression[];
  warnings: string[];
}

// Suffix parse-epub.ts appends to each book's parsed-JSON output; the extraction
// scripts strip it back off to recover the slug. Shared so the two stay in
// lockstep if the naming convention ever changes.
export const PARSED_SUFFIX = "-parsed.json";

// Suffix merge-thread.ts appends to the generated thread file, per the
// project's {bookname}-thread.json naming convention.
export const THREAD_SUFFIX = "-thread.json";

export function deriveSlug(parsedJsonPath: string): string {
  const base = path.basename(parsedJsonPath);
  return base.endsWith(PARSED_SUFFIX) ? base.slice(0, -PARSED_SUFFIX.length) : base;
}
