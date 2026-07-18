import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Thread } from "@pipeline/types";
import { ValidationError, validateThread } from "./validate";

// Client-side persistence for the static wiki. All thread data lives in the
// browser's IndexedDB — nothing is uploaded. Three stores:
//   library — one record per imported book (thread kept verbatim + denormalized
//             counts so the library list needn't parse every thread)
//   prefs   — per-book UI state (chapter cap + active tab)
//   app     — singletons (currently just lastOpenedSlug)
// The verbatim thread text is what re-export writes back, so an exported book
// is byte-identical to the pipeline's original output.

const DB_NAME = "threadline";
const DB_VERSION = 1;
export const BUNDLE_VERSION = 1;

export type TabId = "characters" | "timeline";

export interface LibraryRecord {
  slug: string;
  title: string;
  importedAt: string;
  characterCount: number;
  relationshipCount: number;
  eventCount: number;
  chapterCount: number;
  threadJsonText: string;
}

export type LibrarySummary = Omit<LibraryRecord, "threadJsonText">;

export interface BookPrefs {
  slug: string;
  chapterCap: number;
  activeTab: TabId;
}

interface AppEntry {
  key: string;
  value: string;
}

interface ThreadlineDB extends DBSchema {
  library: { key: string; value: LibraryRecord };
  prefs: { key: string; value: BookPrefs };
  app: { key: string; value: AppEntry };
}

const LAST_OPENED_KEY = "lastOpenedSlug";
// Set once the bundled example thread has been offered to a fresh library.
// Gating on this flag (not on library emptiness) means deleting the example is
// permanent — it isn't re-seeded on the next visit.
const SEEDED_DEFAULTS_KEY = "seededDefaults";
// Bundled example thread, served as a static file from web/public. Fetched at
// runtime (not imported) so its ~512K never lands in the JS bundle.
const DEFAULT_THREAD_FILE = "potters-path-1st-thread.json";

let dbPromise: Promise<IDBPDatabase<ThreadlineDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ThreadlineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ThreadlineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("library", { keyPath: "slug" });
        db.createObjectStore("prefs", { keyPath: "slug" });
        db.createObjectStore("app", { keyPath: "key" });
      },
    });
  }
  return dbPromise;
}

// Test-only: drop the connection + the underlying database so each test starts
// clean. Not used by the app.
export async function resetDbForTests(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await deleteDB(DB_NAME);
}

// --- Pure helpers (no IndexedDB) — the testable core of import/export ---

// Parse + validate a thread's verbatim text into a library record. Throws
// ValidationError on malformed input; the slug comes from the thread itself.
export function recordFromThreadText(threadJsonText: string): { record: LibraryRecord; thread: Thread } {
  let raw: unknown;
  try {
    raw = JSON.parse(threadJsonText);
  } catch {
    throw new ValidationError("thread file: not valid JSON");
  }
  validateThread(raw);
  const thread = raw;
  const record: LibraryRecord = {
    slug: thread.meta.slug,
    title: thread.meta.bookTitle ?? thread.meta.slug,
    importedAt: new Date().toISOString(),
    characterCount: thread.meta.characterCount,
    relationshipCount: thread.meta.relationshipCount,
    eventCount: thread.meta.eventCount,
    chapterCount: thread.meta.chapterCount,
    threadJsonText,
  };
  return { record, thread };
}

export interface ExportBundle {
  version: number;
  exportedAt: string;
  books: { slug: string; threadJsonText: string }[];
  prefs: {
    lastOpenedSlug: string | null;
    perBook: Record<string, { chapterCap: number; activeTab: TabId }>;
  };
}

export function buildBundle(
  books: { slug: string; threadJsonText: string }[],
  perBook: Record<string, { chapterCap: number; activeTab: TabId }>,
  lastOpenedSlug: string | null
): ExportBundle {
  return {
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    books,
    prefs: { lastOpenedSlug, perBook },
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const VALID_TABS: ReadonlySet<string> = new Set<TabId>(["characters", "timeline"]);

// Parse + fully validate a raw export bundle into records ready to write.
// Every embedded thread is validated up front so a bad bundle is rejected
// before any IndexedDB write happens. Prefs referencing books absent from the
// bundle are dropped.
export function parseBundle(raw: unknown): { records: LibraryRecord[]; prefs: BookPrefs[]; lastOpenedSlug: string | null } {
  if (!isObj(raw)) throw new ValidationError("bundle: not a JSON object");
  if (raw.version !== BUNDLE_VERSION) {
    throw new ValidationError(`bundle.version: expected ${BUNDLE_VERSION}, got ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.books)) throw new ValidationError("bundle.books: expected an array");

  const records: LibraryRecord[] = [];
  const slugs = new Set<string>();
  for (const [i, b] of raw.books.entries()) {
    if (!isObj(b) || typeof b.slug !== "string" || typeof b.threadJsonText !== "string") {
      throw new ValidationError(`bundle.books[${i}]: expected { slug, threadJsonText }`);
    }
    const { record } = recordFromThreadText(b.threadJsonText);
    if (record.slug !== b.slug) {
      throw new ValidationError(`bundle.books[${i}]: slug "${b.slug}" disagrees with thread slug "${record.slug}"`);
    }
    records.push(record);
    slugs.add(record.slug);
  }

  const prefs: BookPrefs[] = [];
  let lastOpenedSlug: string | null = null;
  if (raw.prefs !== undefined) {
    if (!isObj(raw.prefs)) throw new ValidationError("bundle.prefs: expected an object");
    const ls = raw.prefs.lastOpenedSlug;
    if (ls !== null && ls !== undefined && typeof ls !== "string") {
      throw new ValidationError("bundle.prefs.lastOpenedSlug: expected a string or null");
    }
    // Only honor a lastOpenedSlug that actually resolves to a bundled book.
    lastOpenedSlug = typeof ls === "string" && slugs.has(ls) ? ls : null;

    const perBook = raw.prefs.perBook;
    if (perBook !== undefined) {
      if (!isObj(perBook)) throw new ValidationError("bundle.prefs.perBook: expected an object");
      for (const [slug, p] of Object.entries(perBook)) {
        if (!slugs.has(slug)) continue; // drop prefs for books not in the bundle
        if (!isObj(p) || !Number.isInteger(p.chapterCap) || typeof p.activeTab !== "string" || !VALID_TABS.has(p.activeTab)) {
          throw new ValidationError(`bundle.prefs.perBook["${slug}"]: expected { chapterCap: int, activeTab }`);
        }
        prefs.push({ slug, chapterCap: p.chapterCap as number, activeTab: p.activeTab as TabId });
      }
    }
  }

  return { records, prefs, lastOpenedSlug };
}

// --- Library operations ---

export async function putThread(threadJsonText: string): Promise<{ slug: string; replaced: boolean }> {
  const { record } = recordFromThreadText(threadJsonText);
  const db = await getDb();
  // One transaction so the exists-check and the write can't interleave with a
  // concurrent import of the same slug (the `replaced` flag would otherwise be
  // racy).
  const tx = db.transaction("library", "readwrite");
  const replaced = (await tx.store.get(record.slug)) !== undefined;
  await tx.store.put(record);
  await tx.done;
  return { slug: record.slug, replaced };
}

export async function listLibrary(): Promise<LibrarySummary[]> {
  const db = await getDb();
  const records = await db.getAll("library");
  return records
    .map(({ threadJsonText: _omit, ...summary }) => summary)
    .sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : 0));
}

export async function getThread(slug: string): Promise<Thread | undefined> {
  const db = await getDb();
  const record = await db.get("library", slug);
  if (!record) return undefined;
  // Stored text is already validated at import; parse is safe.
  return JSON.parse(record.threadJsonText) as Thread;
}

export async function deleteThread(slug: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["library", "prefs", "app"], "readwrite");
  await tx.objectStore("library").delete(slug);
  await tx.objectStore("prefs").delete(slug);
  const app = tx.objectStore("app");
  const last = await app.get(LAST_OPENED_KEY);
  if (last?.value === slug) await app.delete(LAST_OPENED_KEY);
  await tx.done;
}

// --- Preferences ---

export async function getPrefs(slug: string): Promise<BookPrefs | undefined> {
  const db = await getDb();
  return db.get("prefs", slug);
}

export async function setPrefs(prefs: BookPrefs): Promise<void> {
  const db = await getDb();
  await db.put("prefs", prefs);
}

export async function getLastOpened(): Promise<string | null> {
  const db = await getDb();
  const entry = await db.get("app", LAST_OPENED_KEY);
  return entry?.value ?? null;
}

export async function setLastOpened(slug: string | null): Promise<void> {
  const db = await getDb();
  if (slug === null) {
    await db.delete("app", LAST_OPENED_KEY);
  } else {
    await db.put("app", { key: LAST_OPENED_KEY, value: slug });
  }
}

// --- First-run defaults ---

// Seed the bundled example thread into a fresh library, exactly once. The
// `seededDefaults` flag is set whether or not the fetch succeeds, so a missing
// or unreachable example never re-triggers on every load. A failure is
// swallowed: the worst case is an empty library, not a scary error. Safe to
// call on every mount — a no-op once the flag is set. `baseUrl` is
// import.meta.env.BASE_URL so the fetch resolves under the GitHub Pages
// subpath.
export async function seedDefaultsOnce(baseUrl: string): Promise<void> {
  const db = await getDb();
  if ((await db.get("app", SEEDED_DEFAULTS_KEY)) !== undefined) return;
  try {
    const res = await fetch(`${baseUrl}${DEFAULT_THREAD_FILE}`);
    if (res.ok) await putThread(await res.text());
  } catch {
    // network/parse failure — leave the library empty, still mark as seeded
  } finally {
    await db.put("app", { key: SEEDED_DEFAULTS_KEY, value: "1" });
  }
}

// --- Export / import ---

export async function exportBundle(): Promise<ExportBundle> {
  const db = await getDb();
  const [records, allPrefs, lastOpenedSlug] = await Promise.all([
    db.getAll("library"),
    db.getAll("prefs"),
    getLastOpened(),
  ]);
  const books = records.map((r) => ({ slug: r.slug, threadJsonText: r.threadJsonText }));
  const perBook: Record<string, { chapterCap: number; activeTab: TabId }> = {};
  for (const p of allPrefs) perBook[p.slug] = { chapterCap: p.chapterCap, activeTab: p.activeTab };
  return buildBundle(books, perBook, lastOpenedSlug);
}

// Merge a bundle into the library. Validates everything first (parseBundle),
// then writes all books + prefs + lastOpened in a single transaction so a
// mid-import failure can't leave a half-applied library. Same-slug books
// replace the existing copy. Merge (not replace) semantics: books absent from
// the bundle are left untouched, and a bundle whose lastOpenedSlug resolves to
// null deliberately leaves any existing pointer in place (it still refers to a
// book that remains in the library).
export async function importBundle(raw: unknown): Promise<{ imported: number }> {
  const { records, prefs, lastOpenedSlug } = parseBundle(raw);
  const db = await getDb();
  const tx = db.transaction(["library", "prefs", "app"], "readwrite");
  const library = tx.objectStore("library");
  const prefStore = tx.objectStore("prefs");
  for (const record of records) await library.put(record);
  for (const p of prefs) await prefStore.put(p);
  if (lastOpenedSlug !== null) {
    await tx.objectStore("app").put({ key: LAST_OPENED_KEY, value: lastOpenedSlug });
  }
  await tx.done;
  return { imported: records.length };
}
