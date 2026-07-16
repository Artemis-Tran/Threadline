"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readingPositionKey } from "@/lib/constants";

// Renders "Read" until mount, then upgrades the label to "Continue · CH n" if
// a saved reading position exists — localStorage is unavailable during SSR.
// Always links to the /books/[slug] resume route rather than the chapter
// directly: a re-import may have removed the saved chapter, and the resume
// route validates the stored position against the current chapter list.
export default function ContinueLink({ slug, className }: { slug: string; className?: string }) {
  const [position, setPosition] = useState<number | null>(null);

  useEffect(() => {
    const raw = window.localStorage.getItem(readingPositionKey(slug));
    if (raw !== null && /^\d+$/.test(raw)) {
      setPosition(Number(raw));
    }
  }, [slug]);

  return (
    <Link className={className} href={`/books/${slug}`}>
      {position === null ? "Read →" : `Continue · CH ${position} →`}
    </Link>
  );
}
