import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// books holds the whole Thread as a verbatim JSON blob (the client consumes it
// as a unit; nothing queries inside it server-side) plus denormalized counts
// for the list page. chapters is normalized so the reader can fetch one
// chapter's text at a time and the nav can list titles without text.
const DDL = `
CREATE TABLE IF NOT EXISTS books (
  slug TEXT PRIMARY KEY,
  title TEXT, creator TEXT, language TEXT,
  chapter_count INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  thread_json TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  relationship_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  thread_chapter_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chapters (
  slug TEXT NOT NULL REFERENCES books(slug) ON DELETE CASCADE,
  chapter_index INTEGER NOT NULL,
  epub_id TEXT NOT NULL, href TEXT NOT NULL,
  title TEXT, word_count INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (slug, chapter_index)
);
`;

export function openDb(file: string): Database.Database {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  return db;
}

function defaultDbPath(): string {
  // cwd is web/ under `npm run dev -w web`; THREADLINE_DB overrides for tests.
  return process.env.THREADLINE_DB ?? path.join(process.cwd(), "data", "threadline.db");
}

// Cached on globalThis so Next dev-mode HMR doesn't stack up connections.
declare global {
  // eslint-disable-next-line no-var
  var __threadlineDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (!globalThis.__threadlineDb) {
    globalThis.__threadlineDb = openDb(defaultDbPath());
  }
  return globalThis.__threadlineDb;
}
