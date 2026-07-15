import * as path from "path";

// Shared data shapes for the extraction pipeline. parse-epub.ts produces
// ParsedBook; the extraction stages consume it. Keeping these in one place
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

export interface ExtractedCharacter {
  name: string;
  aliases: string[];
  description: string;
  role: CharacterRole;
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

// The stage-3 (extract-book.ts) hint roster, persisted in manifest.json. Not
// authoritative — capped aliases, truncated descriptions, longest-string-wins
// merge. Stage 4 (merge-thread.ts) rebuilds its own full history from the
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
  };
  chapters: ManifestChapterEntry[];
  roster: RosterEntry[];
}

// Suffix parse-epub.ts appends to each book's parsed-JSON output; the extraction
// scripts strip it back off to recover the slug. Shared so the two stay in
// lockstep if the naming convention ever changes.
export const PARSED_SUFFIX = "-parsed.json";

export function deriveSlug(parsedJsonPath: string): string {
  const base = path.basename(parsedJsonPath);
  return base.endsWith(PARSED_SUFFIX) ? base.slice(0, -PARSED_SUFFIX.length) : base;
}
