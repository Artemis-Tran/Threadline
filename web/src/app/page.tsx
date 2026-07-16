import Link from "next/link";
import { getDb } from "@/lib/db";
import { listBooks } from "@/lib/repo";
import ContinueLink from "@/components/ContinueLink";
import styles from "./home.module.css";

// The book list reads SQLite directly; without this Next would statically
// cache the page at build time with whatever the DB held then.
export const dynamic = "force-dynamic";

export default function Home() {
  const books = listBooks(getDb());

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <h1 className={styles.appTitle}>Threadline</h1>
        <Link href="/upload" className={styles.uploadLink}>
          + Import a book
        </Link>
      </header>

      {books.length === 0 ? (
        <section className={styles.empty}>
          <p>No books yet.</p>
          <p>
            <Link href="/upload">Import a book</Link> by uploading the pipeline&apos;s{" "}
            <code>-thread.json</code> and <code>-parsed.json</code> files.
          </p>
        </section>
      ) : (
        <ul className={styles.bookList}>
          {books.map((book) => (
            <li key={book.slug} className={styles.bookCard}>
              <div className={styles.bookCardTop}>
                <h2 className={styles.bookTitle}>{book.title ?? book.slug}</h2>
                {book.creator && <span className={styles.bookAuthor}>{book.creator}</span>}
              </div>
              <dl className={styles.statStrip}>
                <div className={styles.stat}>
                  <dt>chapters</dt>
                  <dd>{book.chapterCount}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>characters</dt>
                  <dd>{book.characterCount}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>relationships</dt>
                  <dd>{book.relationshipCount}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>events</dt>
                  <dd>{book.eventCount}</dd>
                </div>
              </dl>
              <div className={styles.bookCardBottom}>
                <span className={styles.coverage}>
                  thread covers {book.threadChapterCount} of {book.chapterCount} chapters
                </span>
                <ContinueLink slug={book.slug} className={styles.readLink} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
