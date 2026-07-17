import type { MergedEvent, RelationshipStatement, Thread } from "@pipeline/types";

// Minimal-but-valid thread fixture for the web data layer / selector tests.
// Deep-cloned on every call so tests can mutate freely. Hen deliberately
// appears as "Hen" at ch 1 and "Hen Ashworth" at ch 2 (with the top-level
// whole-book name also "Hen Ashworth") so spoiler-gating can be asserted.

function statement(chapterIndex: number, description: string): RelationshipStatement {
  return {
    chapterIndex,
    chapterTitle: `Chapter ${chapterIndex}`,
    fromId: "hen",
    fromName: "Hen",
    toId: "mara",
    toName: "Mara",
    type: "friends",
    description,
  };
}

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  const events: MergedEvent[] = [
    {
      chapterIndex: 1,
      chapterTitle: "Chapter 1",
      summary: "Hen meets Mara.",
      significance: "major",
      charactersInvolved: [
        { id: "hen", name: "Hen" },
        { id: "mara", name: "Mara" },
      ],
    },
    {
      chapterIndex: 2,
      chapterTitle: "Chapter 2",
      summary: "An unnamed stranger passes through.",
      significance: "minor",
      charactersInvolved: [{ id: null, name: "the stranger" }],
    },
  ];
  const base: Thread = {
    meta: {
      bookTitle: "Test Book",
      slug: "test-book",
      sourceManifest: "output/test-book-chunks/manifest.json",
      generatedAt: "2026-07-15T00:00:00.000Z",
      chapterCount: 2,
      characterCount: 2,
      relationshipCount: 1,
      eventCount: 2,
      conflictCount: 0,
      progressionRegressionCount: 0,
      warningCount: 0,
    },
    characters: [
      {
        id: "hen",
        name: "Hen Ashworth",
        aliases: ["the potter"],
        description: "Whole-book description of Hen.",
        appearances: [
          {
            chapterIndex: 1,
            chapterTitle: "Chapter 1",
            name: "Hen",
            aliases: [],
            description: "A young potter.",
            role: "pov",
          },
          {
            chapterIndex: 2,
            chapterTitle: "Chapter 2",
            name: "Hen Ashworth",
            aliases: ["the potter"],
            description: "A young potter, now revealed as an Ashworth.",
            role: "pov",
          },
        ],
        firstAppearedChapterIndex: 1,
        lastAppearedChapterIndex: 2,
        conflicts: [],
        progressionRegressions: [],
      },
      {
        id: "mara",
        name: "Mara",
        aliases: [],
        description: "Hen's neighbor.",
        appearances: [
          {
            chapterIndex: 1,
            chapterTitle: "Chapter 1",
            name: "Mara",
            aliases: [],
            description: "A neighbor.",
            role: "supporting",
          },
        ],
        firstAppearedChapterIndex: 1,
        lastAppearedChapterIndex: 1,
        conflicts: [],
        progressionRegressions: [],
      },
    ],
    relationships: [
      {
        id: "hen--mara",
        participantIds: ["hen", "mara"],
        current: statement(2, "Fast friends."),
        history: [statement(1, "Just met."), statement(2, "Fast friends.")],
      },
    ],
    events,
    conflicts: [],
    progressionRegressions: [],
    warnings: [],
  };
  return { ...structuredClone(base), ...overrides };
}
