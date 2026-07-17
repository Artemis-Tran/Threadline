import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Thread } from "@pipeline/types";
import { getThread, setLastOpened } from "../lib/db";
import { chapterRange } from "../lib/asOf";
import styles from "./BookPage.module.css";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; thread: Thread };

export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    if (!slug) {
      setState({ status: "missing" });
      return;
    }
    void (async () => {
      try {
        const thread = await getThread(slug);
        if (!active) return;
        if (!thread) {
          setState({ status: "missing" });
          return;
        }
        await setLastOpened(slug);
        if (!active) return; // navigation may have moved on during the await
        setState({ status: "ready", thread });
      } catch (e) {
        if (active) {
          setState({ status: "error", message: e instanceof Error ? e.message : "Failed to load this book." });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [slug]);

  if (state.status === "loading") {
    return (
      <main className={styles.page}>
        <p className={styles.muted}>Loading…</p>
      </main>
    );
  }

  if (state.status === "missing" || state.status === "error") {
    return (
      <main className={styles.page}>
        <p className={styles.crumb}>
          <Link to="/">← Library</Link>
        </p>
        <p className={styles.muted}>
          {state.status === "missing" ? "That book isn’t in your library." : state.message}
        </p>
      </main>
    );
  }

  const { thread } = state;
  const range = chapterRange(thread);

  return (
    <main className={styles.page}>
      <p className={styles.crumb}>
        <Link to="/">← Library</Link>
      </p>
      <h1 className={styles.title}>{thread.meta.bookTitle ?? thread.meta.slug}</h1>
      <dl className={styles.stats}>
        <div>
          <dt>Characters</dt>
          <dd>{thread.meta.characterCount}</dd>
        </div>
        <div>
          <dt>Relationships</dt>
          <dd>{thread.meta.relationshipCount}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{thread.meta.eventCount}</dd>
        </div>
        {range && (
          <div>
            <dt>Chapters</dt>
            <dd>
              {range.min}–{range.max}
            </dd>
          </div>
        )}
      </dl>
      <p className={styles.placeholder}>
        The wiki view — Characters, Timeline, and the “world as of chapter N” cap — arrives in the next stage.
      </p>
    </main>
  );
}
