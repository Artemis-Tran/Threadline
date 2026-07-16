"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./upload.module.css";

interface ImportSummary {
  slug: string;
  replaced: boolean;
  title: string | null;
  chapterCount: number;
  characterCount: number;
  relationshipCount: number;
  eventCount: number;
}

export default function UploadPage() {
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSummary(null);
    setBusy(true);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      // Framework-level failures (body size, crashes) may not return JSON.
      let body: { error?: string } & ImportSummary;
      try {
        body = await res.json();
      } catch {
        setError(`Import failed (HTTP ${res.status}).`);
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `Import failed (HTTP ${res.status}).`);
      } else {
        setSummary(body);
      }
    } catch {
      setError("Import request failed — is the server still running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <p className={styles.crumb}>
        <Link href="/">← Library</Link>
      </p>
      <h1 className={styles.title}>Import a book</h1>
      <p className={styles.lede}>
        Upload the two files the pipeline wrote to <code>output/</code> for a book: its{" "}
        <code>{"{slug}"}-thread.json</code> and its <code>{"{slug}"}-parsed.json</code>.
      </p>

      <form onSubmit={onSubmit} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Thread JSON</span>
          <input type="file" name="thread" accept=".json,application/json" required />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Parsed book JSON</span>
          <input type="file" name="parsed" accept=".json,application/json" required />
        </label>
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? "Importing…" : "Import"}
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}

      {summary && (
        <section className={styles.summary}>
          <h2 className={styles.summaryTitle}>
            {summary.title ?? summary.slug}
            {summary.replaced && <span className={styles.replaced}> — replaced existing import</span>}
          </h2>
          <dl className={styles.statStrip}>
            <div className={styles.stat}>
              <dt>chapters</dt>
              <dd>{summary.chapterCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>characters</dt>
              <dd>{summary.characterCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>relationships</dt>
              <dd>{summary.relationshipCount}</dd>
            </div>
            <div className={styles.stat}>
              <dt>events</dt>
              <dd>{summary.eventCount}</dd>
            </div>
          </dl>
          <Link className={styles.readLink} href={`/books/${summary.slug}`}>
            Start reading →
          </Link>
        </section>
      )}
    </main>
  );
}
