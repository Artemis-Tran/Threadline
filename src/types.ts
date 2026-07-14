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

export interface ExtractedCharacter {
  name: string;
  aliases: string[];
  description: string;
  role: string;
}

export interface Extraction {
  characters: ExtractedCharacter[];
  relationships: unknown[];
  events: unknown[];
}

// Suffix parse-epub.ts appends to each book's parsed-JSON output; the extraction
// scripts strip it back off to recover the slug. Shared so the two stay in
// lockstep if the naming convention ever changes.
export const PARSED_SUFFIX = "-parsed.json";

export function deriveSlug(parsedJsonPath: string): string {
  const base = path.basename(parsedJsonPath);
  return base.endsWith(PARSED_SUFFIX) ? base.slice(0, -PARSED_SUFFIX.length) : base;
}
