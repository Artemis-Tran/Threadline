import type { Database } from "better-sqlite3";
import type { ParsedBook, Thread } from "@pipeline/types";

// Thin data layer over the two tables in db.ts. Every function takes the
// Database explicitly so tests can pass a :memory: instance; app call sites
// pass getDb().

export interface BookRow {
  slug: string;
  title: string | null;
  creator: string | null;
  language: string | null;
  chapterCount: number;
  wordCount: number;
  characterCount: number;
  relationshipCount: number;
  eventCount: number;
  threadChapterCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterListEntry {
  index: number;
  title: string | null;
  wordCount: number;
}

export interface ChapterRow extends ChapterListEntry {
  epubId: string;
  href: string;
  text: string;
}

const BOOK_COLUMNS = `
  slug, title, creator, language,
  chapter_count AS chapterCount,
  word_count AS wordCount,
  character_count AS characterCount,
  relationship_count AS relationshipCount,
  event_count AS eventCount,
  thread_chapter_count AS threadChapterCount,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export function listBooks(db: Database): BookRow[] {
  return db.prepare(`SELECT ${BOOK_COLUMNS} FROM books ORDER BY updated_at DESC`).all() as BookRow[];
}

export function getBook(db: Database, slug: string): BookRow | undefined {
  return db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE slug = ?`).get(slug) as BookRow | undefined;
}

export function getChapterList(db: Database, slug: string): ChapterListEntry[] {
  return db
    .prepare(
      `SELECT chapter_index AS "index", title, word_count AS wordCount
       FROM chapters WHERE slug = ? ORDER BY chapter_index`
    )
    .all(slug) as ChapterListEntry[];
}

export function getChapter(db: Database, slug: string, index: number): ChapterRow | undefined {
  return db
    .prepare(
      `SELECT chapter_index AS "index", epub_id AS epubId, href, title,
              word_count AS wordCount, text
       FROM chapters WHERE slug = ? AND chapter_index = ?`
    )
    .get(slug, index) as ChapterRow | undefined;
}

export function getThreadJson(db: Database, slug: string): string | undefined {
  const row = db.prepare(`SELECT thread_json AS threadJson FROM books WHERE slug = ?`).get(slug) as
    | { threadJson: string }
    | undefined;
  return row?.threadJson;
}

export interface ImportResult {
  slug: string;
  replaced: boolean;
}

// threadJsonText is stored verbatim (not re-serialized) so what the client
// fetches is byte-identical to what the pipeline produced.
export function importBook(
  db: Database,
  parsed: ParsedBook,
  thread: Thread,
  threadJsonText: string
): ImportResult {
  const slug = thread.meta.slug;
  const replaced = getBook(db, slug) !== undefined;

  const upsertBook = db.prepare(`
    INSERT INTO books (
      slug, title, creator, language, chapter_count, word_count,
      thread_json, character_count, relationship_count, event_count, thread_chapter_count
    ) VALUES (
      @slug, @title, @creator, @language, @chapterCount, @wordCount,
      @threadJson, @characterCount, @relationshipCount, @eventCount, @threadChapterCount
    )
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      creator = excluded.creator,
      language = excluded.language,
      chapter_count = excluded.chapter_count,
      word_count = excluded.word_count,
      thread_json = excluded.thread_json,
      character_count = excluded.character_count,
      relationship_count = excluded.relationship_count,
      event_count = excluded.event_count,
      thread_chapter_count = excluded.thread_chapter_count,
      updated_at = datetime('now')
  `);
  const deleteChapters = db.prepare(`DELETE FROM chapters WHERE slug = ?`);
  const insertChapter = db.prepare(`
    INSERT INTO chapters (slug, chapter_index, epub_id, href, title, word_count, text)
    VALUES (@slug, @index, @epubId, @href, @title, @wordCount, @text)
  `);

  db.transaction(() => {
    upsertBook.run({
      slug,
      title: parsed.title,
      creator: parsed.creator,
      language: parsed.language,
      chapterCount: parsed.chapters.length,
      wordCount: parsed.wordCount,
      threadJson: threadJsonText,
      characterCount: thread.meta.characterCount,
      relationshipCount: thread.meta.relationshipCount,
      eventCount: thread.meta.eventCount,
      threadChapterCount: thread.meta.chapterCount,
    });
    deleteChapters.run(slug);
    for (const c of parsed.chapters) {
      insertChapter.run({
        slug,
        index: c.index,
        epubId: c.id,
        href: c.href,
        title: c.title,
        wordCount: c.wordCount,
        text: c.text,
      });
    }
  })();

  return { slug, replaced };
}
