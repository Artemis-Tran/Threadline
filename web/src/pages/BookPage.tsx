import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Thread } from "@pipeline/types";
import { getPrefs, getThread, setLastOpened, setPrefs, type TabId } from "../lib/db";
import {
  chapterRange,
  chapterTitleMap,
  characterAsOf,
  charactersAsOf,
  eventsAsOf,
  eventsForCharacterAsOf,
  relationshipsForCharacterAsOf,
  resolveCap,
  statsAsOf,
  type ChapterRange,
} from "../lib/asOf";
import CharactersTab from "../components/CharactersTab";
import CharacterDetail from "../components/CharacterDetail";
import TimelineTab from "../components/TimelineTab";
import styles from "./BookPage.module.css";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; thread: Thread; range: ChapterRange };

function parseIntOrNull(s: string | null): number | null {
  if (s === null) return null;
  const t = s.trim();
  // Reject empty/whitespace/exponent forms — Number("") is 0, which would
  // wrongly override saved prefs for a range that includes chapter 0.
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function readTab(s: string | null): TabId | null {
  return s === "timeline" || s === "characters" ? s : null;
}

export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [cap, setCap] = useState(0);
  const [tab, setTab] = useState<TabId>("characters");
  const [character, setCharacter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const initialized = useRef(false);

  // Load the thread; seed cap/tab/character from the URL (deep links win), then
  // saved prefs, then the safe default. Then canonicalize the URL (so it matches
  // state and is shareable) and persist the resolved position. Reads
  // searchParams only at load time on purpose.
  useEffect(() => {
    let active = true;
    initialized.current = false;
    setState({ status: "loading" });
    if (!slug) {
      setState({ status: "missing" });
      return;
    }
    void (async () => {
      try {
        const [thread, prefs] = await Promise.all([getThread(slug), getPrefs(slug)]);
        if (!active) return;
        if (!thread) {
          setState({ status: "missing" });
          return;
        }
        await setLastOpened(slug);
        if (!active) return;
        const range = chapterRange(thread);
        if (!range) {
          setState({ status: "empty" });
          return;
        }
        const urlChar = searchParams.get("character");
        const initCap = resolveCap([parseIntOrNull(searchParams.get("upto")), prefs?.chapterCap ?? null], range);
        const initTab = readTab(searchParams.get("tab")) ?? prefs?.activeTab ?? "characters";
        const initChar = urlChar && urlChar.length > 0 ? urlChar : null;

        setCap(initCap);
        setTab(initTab);
        setCharacter(initChar);
        setQuery("");
        setState({ status: "ready", thread, range });

        const p = new URLSearchParams();
        p.set("upto", String(initCap));
        p.set("tab", initTab);
        if (initChar) p.set("character", initChar);
        setSearchParams(p, { replace: true });
        void setPrefs({ slug, chapterCap: initCap, activeTab: initTab }).catch(() => {});

        initialized.current = true;
      } catch (e) {
        if (active) {
          setState({ status: "error", message: e instanceof Error ? e.message : "Failed to load this book." });
        }
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Reconcile state from the URL when it changes externally (browser Back/
  // Forward). Handlers below update state and URL together, so those pass
  // through here as no-ops; only an out-of-band URL change moves state.
  useEffect(() => {
    if (!initialized.current || state.status !== "ready") return;
    const urlCap = resolveCap([parseIntOrNull(searchParams.get("upto"))], state.range);
    const urlTab = readTab(searchParams.get("tab")) ?? "characters";
    const urlChar = searchParams.get("character") || null;
    if (urlCap !== cap) setCap(urlCap);
    if (urlTab !== tab) setTab(urlTab);
    if (urlChar !== character) setCharacter(urlChar);
  }, [searchParams, state, cap, tab, character]);

  // Persist cap + tab per book, debounced so a slider drag isn't hundreds of writes.
  useEffect(() => {
    if (!initialized.current || !slug) return;
    const id = window.setTimeout(() => void setPrefs({ slug, chapterCap: cap, activeTab: tab }).catch(() => {}), 250);
    return () => window.clearTimeout(id);
  }, [cap, tab, slug]);

  // Write state + URL together. Slider/tab use replace (no history noise);
  // opening a character pushes so browser Back returns to the list.
  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, replace: boolean) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          mutate(p);
          return p;
        },
        { replace }
      );
    },
    [setSearchParams]
  );

  const changeCap = useCallback(
    (n: number) => {
      setCap(n);
      updateParams((p) => p.set("upto", String(n)), true);
    },
    [updateParams]
  );
  const selectCharacter = useCallback(
    (id: string) => {
      setTab("characters");
      setCharacter(id);
      window.scrollTo({ top: 0 });
      updateParams((p) => {
        p.set("tab", "characters");
        p.set("character", id);
      }, false);
    },
    [updateParams]
  );
  const clearCharacter = useCallback(() => {
    setCharacter(null);
    updateParams((p) => p.delete("character"), true);
  }, [updateParams]);
  const changeTab = useCallback(
    (t: TabId) => {
      setTab(t);
      setCharacter(null);
      updateParams((p) => {
        p.set("tab", t);
        p.delete("character");
      }, true);
    },
    [updateParams]
  );

  const ready = state.status === "ready" ? state : null;

  const titleMap = useMemo(
    () => (ready ? chapterTitleMap(ready.thread, cap) : new Map<number, string>()),
    [ready, cap]
  );
  const chapterTitle = useCallback((i: number) => titleMap.get(i), [titleMap]);
  const chapterLabel = useCallback(
    (i: number) => {
      const title = titleMap.get(i);
      if (!title) return `Chapter index ${i}`;
      // Keep ordinary chapter labels compact while preserving meaningful
      // non-numbered titles such as POV chapters and interludes.
      return title.match(/^Chapter\s+\d+\b/i)?.[0] ?? title;
    },
    [titleMap]
  );

  const characters = useMemo(() => {
    if (!ready) return [];
    const all = charactersAsOf(ready.thread, cap);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q))
    );
  }, [ready, cap, query]);

  const events = useMemo(() => {
    if (!ready) return [];
    const all = eventsAsOf(ready.thread, cap);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (e) => e.summary.toLowerCase().includes(q) || e.participants.some((p) => p.name.toLowerCase().includes(q))
    );
  }, [ready, cap, query]);

  const detail = useMemo(
    () => (ready && character ? characterAsOf(ready.thread, cap, character) : null),
    [ready, cap, character]
  );
  const detailRels = useMemo(
    () => (ready && character ? relationshipsForCharacterAsOf(ready.thread, cap, character) : []),
    [ready, cap, character]
  );
  const detailEvents = useMemo(
    () => (ready && character ? eventsForCharacterAsOf(ready.thread, cap, character) : []),
    [ready, cap, character]
  );

  if (state.status === "loading") {
    return (
      <main className={styles.page}>
        <p className={styles.muted}>Loading…</p>
      </main>
    );
  }
  if (state.status === "missing" || state.status === "error" || state.status === "empty") {
    return (
      <main className={styles.page}>
        <p className={styles.crumb}>
          <Link to="/">← Library</Link>
        </p>
        <p className={styles.muted}>
          {state.status === "missing"
            ? "That book isn’t in your library."
            : state.status === "empty"
              ? "This thread has no chapter data to show."
              : state.message}
        </p>
      </main>
    );
  }

  const { thread, range } = state;
  const stats = statsAsOf(thread, cap);
  const capTitle = chapterTitle(cap);

  return (
    <main className={styles.page}>
      <p className={styles.crumb}>
        <Link to="/">← Library</Link>
      </p>
      <h1 className={styles.title}>{thread.meta.bookTitle ?? thread.meta.slug}</h1>

      <section className={styles.cap}>
        <div className={styles.capHead}>
          <span className={styles.capLabel}>Showing the world as of</span>
          <span className={styles.capChapter}>{capTitle ?? chapterLabel(cap)}</span>
        </div>
        <input
          type="range"
          className={styles.slider}
          min={range.min}
          max={range.max}
          value={cap}
          onChange={(e) => changeCap(Number(e.target.value))}
          aria-label="Chapter cap"
        />
        <div className={styles.capEnds}>
          <span>Index {range.min}</span>
          <span>Index {range.max}</span>
        </div>
        <p className={styles.capHint}>Only what’s known up to this chapter is shown — drag left to avoid spoilers.</p>
      </section>

      <div className={styles.tabBar}>
        <div className={styles.tabs}>
          <button
            className={tab === "characters" ? styles.tabActive : styles.tab}
            onClick={() => changeTab("characters")}
          >
            Characters <span className={styles.tabCount}>{stats.characters}</span>
          </button>
          <button
            className={tab === "timeline" ? styles.tabActive : styles.tab}
            onClick={() => changeTab("timeline")}
          >
            Timeline <span className={styles.tabCount}>{stats.events}</span>
          </button>
        </div>
        {!character && (
          <input
            className={styles.search}
            type="search"
            placeholder={tab === "characters" ? "Search characters…" : "Search events…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      {character ? (
        detail ? (
          <CharacterDetail
            detail={detail}
            relationships={detailRels}
            events={detailEvents}
            onSelectCharacter={selectCharacter}
            onBack={clearCharacter}
            chapterLabel={chapterLabel}
          />
        ) : (
          <div>
            <button className={styles.backFallback} onClick={clearCharacter}>
              ← All characters
            </button>
            <p className={styles.muted}>This character hasn’t appeared yet as of {chapterLabel(cap)}.</p>
          </div>
        )
      ) : tab === "characters" ? (
        <CharactersTab characters={characters} onSelect={selectCharacter} chapterLabel={chapterLabel} />
      ) : (
        <TimelineTab events={events} onSelectCharacter={selectCharacter} chapterLabel={chapterLabel} />
      )}
    </main>
  );
}
