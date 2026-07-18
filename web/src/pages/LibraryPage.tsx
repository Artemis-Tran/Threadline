import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteThread,
  exportBundle,
  getLastOpened,
  importBundle,
  listLibrary,
  putThread,
  seedDefaultsOnce,
  type LibrarySummary,
} from "../lib/db";
import { downloadJson } from "../lib/download";
import styles from "./LibraryPage.module.css";

interface Notice {
  added: string[];
  failed: string[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "unexpected error";
}

export default function LibraryPage() {
  const [books, setBooks] = useState<LibrarySummary[]>([]);
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const busyRef = useRef(false);
  const threadInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, last] = await Promise.all([listLibrary(), getLastOpened()]);
      setBooks(list);
      setLastOpened(last);
    } catch (e) {
      setNotice({ added: [], failed: [`Couldn’t read your library: ${errorMessage(e)}`] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Seed the bundled example on first run, then load the library. Both the
    // seed and the refresh already swallow their own errors.
    void seedDefaultsOnce(import.meta.env.BASE_URL).then(refresh, refresh);
  }, [refresh]);

  // Serialize every library mutation: only one runs at a time (a second
  // trigger while busy is ignored, not queued), and any unexpected failure is
  // surfaced through the notice rather than escaping as an unhandled rejection.
  const runExclusive = useCallback(async (op: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await op();
    } catch (e) {
      setNotice({ added: [], failed: [errorMessage(e)] });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const importThreads = useCallback(
    (files: FileList | File[]) =>
      runExclusive(async () => {
        const added: string[] = [];
        const failed: string[] = [];
        for (const file of Array.from(files)) {
          try {
            const { slug, replaced } = await putThread(await file.text());
            added.push(`${slug}${replaced ? " (replaced)" : ""}`);
          } catch (e) {
            failed.push(`${file.name}: ${errorMessage(e)}`);
          }
        }
        setNotice({ added, failed });
        await refresh();
      }),
    [runExclusive, refresh]
  );

  const importLibraryBundle = useCallback(
    (file: File) =>
      runExclusive(async () => {
        try {
          const raw = JSON.parse(await file.text());
          const { imported } = await importBundle(raw);
          setNotice({ added: [`Imported ${imported} book(s) from ${file.name}`], failed: [] });
        } catch (e) {
          setNotice({ added: [], failed: [`${file.name}: ${errorMessage(e)}`] });
        }
        await refresh();
      }),
    [runExclusive, refresh]
  );

  function handleDelete(book: LibrarySummary) {
    if (busyRef.current) return;
    const ok = window.confirm(
      `Remove "${book.title}" from your library?\n\nThis deletes it from this browser only — your original ${book.slug}-thread.json file is untouched.`
    );
    if (!ok) return;
    void runExclusive(async () => {
      await deleteThread(book.slug);
      await refresh();
    });
  }

  function handleExport() {
    setNotice(null);
    void runExclusive(async () => {
      downloadJson("threadline-library.json", await exportBundle());
    });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) void importThreads(e.dataTransfer.files);
  }

  return (
    <main
      className={`${styles.page} ${dragging ? styles.dragging : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className={styles.masthead}>
        <h1 className={styles.appTitle}>Threadline</h1>
        <div className={styles.actions}>
          <button className={styles.primary} onClick={() => threadInput.current?.click()} disabled={busy}>
            + Add thread
          </button>
          <button className={styles.ghost} onClick={handleExport} disabled={busy || books.length === 0}>
            Export library
          </button>
          <button className={styles.ghost} onClick={() => bundleInput.current?.click()} disabled={busy}>
            Import library
          </button>
        </div>
      </header>

      <input
        ref={threadInput}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void importThreads(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={bundleInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importLibraryBundle(f);
          e.target.value = "";
        }}
      />

      {notice && (notice.added.length > 0 || notice.failed.length > 0) && (
        <div className={styles.notice}>
          {notice.added.map((m) => (
            <p key={m} className={styles.noticeOk}>
              ✓ {m}
            </p>
          ))}
          {notice.failed.map((m) => (
            <p key={m} className={styles.noticeErr}>
              ✕ {m}
            </p>
          ))}
          <button className={styles.noticeClose} onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {loading ? (
        <p className={styles.muted}>Loading your library…</p>
      ) : books.length === 0 ? (
        <section className={styles.empty}>
          <p className={styles.emptyLead}>Your library is empty.</p>
          <p className={styles.muted}>
            Drop a <code>{"{book}"}-thread.json</code> file here, or use <strong>+ Add thread</strong>. Threads stay in
            this browser — nothing is uploaded.
          </p>
        </section>
      ) : (
        <ul className={styles.grid}>
          {books.map((book) => (
            <li key={book.slug} className={styles.card}>
              <Link to={`/book/${encodeURIComponent(book.slug)}`} className={styles.cardLink}>
                <h2 className={styles.cardTitle}>{book.title}</h2>
                {book.slug === lastOpened && <span className={styles.lastOpened}>Last opened</span>}
                <dl className={styles.stats}>
                  <div>
                    <dt>Characters</dt>
                    <dd>{book.characterCount}</dd>
                  </div>
                  <div>
                    <dt>Relationships</dt>
                    <dd>{book.relationshipCount}</dd>
                  </div>
                  <div>
                    <dt>Events</dt>
                    <dd>{book.eventCount}</dd>
                  </div>
                </dl>
              </Link>
              <button className={styles.delete} onClick={() => handleDelete(book)} disabled={busy}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {dragging && <div className={styles.dropHint}>Drop thread files to import</div>}
    </main>
  );
}
