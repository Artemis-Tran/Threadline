import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Thread } from "@pipeline/types";
import { getPrefs, getThread, setLastOpened, setPrefs, type RelViewId, type TabId } from "../lib/db";
import {
  chapterRange,
  chapterTitleMap,
  characterAsOf,
  charactersAsOf,
  eventsAsOf,
  eventsForCharacterAsOf,
  relationshipEdgesAsOf,
  relationshipsForCharacterAsOf,
  resolveCap,
  statsAsOf,
  type ChapterRange,
} from "../lib/asOf";
import type { NodeCatalog } from "../lib/graph";
import CharactersTab from "../components/CharactersTab";
import ThemeToggle from "../components/ThemeToggle";
import CharacterDetail from "../components/CharacterDetail";
import TimelineTab from "../components/TimelineTab";
import styles from "./BookPage.module.css";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "empty" }
  | { status: "error"; message: string }
  // defaults carry the prefs-resolved cap/tab so the URL-derived view state
  // has a correct fallback while the canonical URL write is still in transit.
  | {
      status: "ready";
      thread: Thread;
      range: ChapterRange;
      defaults: { cap: number; tab: TabId; rel: RelViewId };
    };

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

function readRelView(s: string | null): RelViewId | null {
  return s === "grid" || s === "graph" ? s : null;
}

export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  // The URL is the single source of truth for cap/tab/character — they are
  // derived from searchParams below, never mirrored into useState. Mirroring
  // caused visible A-B-A stutters: setSearchParams applies in a React
  // transition, so mirrored state landed a render before the URL, and any
  // "reconcile from URL" effect misread the gap as an external navigation and
  // reverted fresh state to stale URL values (then flipped it forward again).
  //
  // optimisticParams exists only for write *chaining*: two quick writes to
  // different fields in the same gap must build on each other, not on the
  // render's lagging searchParams. It never feeds rendering, and any URL
  // landing clears it (see effect below).
  const optimisticParams = useRef<URLSearchParams | null>(null);
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  useEffect(() => {
    // Any landed URL change ends the chaining window: from here, new writes
    // must build on the real URL (our writes landed, or Back/Forward won).
    optimisticParams.current = null;
  }, [searchParams]);

  // Load the thread; seed cap/tab/character from the URL (deep links win), then
  // saved prefs, then the safe default. Then canonicalize the URL (so it matches
  // state and is shareable) and persist the resolved position. Reads
  // searchParams only at load time on purpose.
  useEffect(() => {
    let active = true;
    optimisticParams.current = null;
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
        const initRel = readRelView(searchParams.get("rel")) ?? prefs?.relView ?? "grid";
        const initChar = urlChar && urlChar.length > 0 ? urlChar : null;

        setQuery("");
        setState({ status: "ready", thread, range, defaults: { cap: initCap, tab: initTab, rel: initRel } });

        const p = new URLSearchParams();
        p.set("upto", String(initCap));
        p.set("tab", initTab);
        p.set("rel", initRel);
        if (initChar) p.set("character", initChar);
        if (p.toString() !== searchParams.toString()) {
          setSearchParams(p, { replace: true });
        }
        void setPrefs({ slug, chapterCap: initCap, activeTab: initTab, relView: initRel }).catch(() => {});
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

  const ready = state.status === "ready" ? state : null;

  // View state, derived from the URL every render — deep links and Back/
  // Forward are handled by construction, with no reconciliation logic. The
  // defaults cover the frames before the canonical URL write lands (and a
  // hand-edited URL missing a param).
  const cap = ready ? resolveCap([parseIntOrNull(searchParams.get("upto")), ready.defaults.cap], ready.range) : 0;
  const tab: TabId = (ready && readTab(searchParams.get("tab"))) || (ready ? ready.defaults.tab : "characters");
  const relView: RelViewId = (ready && readRelView(searchParams.get("rel"))) || (ready ? ready.defaults.rel : "grid");
  const rawChar = searchParams.get("character");
  const character = rawChar && rawChar.length > 0 ? rawChar : null;

  // Persist cap + tab + relationships sub-view per book, debounced so a
  // slider drag isn't hundreds of writes.
  useEffect(() => {
    if (!ready || !slug) return;
    const id = window.setTimeout(
      () => void setPrefs({ slug, chapterCap: cap, activeTab: tab, relView }).catch(() => {}),
      250
    );
    return () => window.clearTimeout(id);
  }, [ready, cap, tab, relView, slug]);

  // All interaction goes through the URL. Slider/tab use replace (no history
  // noise); opening a character pushes so browser Back returns to the list.
  // Writes chain off optimisticParams (not the render's searchParams, which
  // lags behind in a transition) so rapid successive writes to different
  // fields build on each other instead of clobbering; no-op writes are skipped.
  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, replace: boolean) => {
      const base = optimisticParams.current ?? searchParamsRef.current;
      const p = new URLSearchParams(base);
      mutate(p);
      if (p.toString() === base.toString()) return;
      optimisticParams.current = p;
      setSearchParams(p, { replace });
    },
    [setSearchParams]
  );

  const changeCap = useCallback((n: number) => updateParams((p) => p.set("upto", String(n)), true), [updateParams]);
  const selectCharacter = useCallback(
    (id: string) => {
      window.scrollTo({ top: 0 });
      updateParams((p) => {
        p.set("tab", "characters");
        p.set("character", id);
      }, false);
    },
    [updateParams]
  );
  const clearCharacter = useCallback(() => updateParams((p) => p.delete("character"), true), [updateParams]);
  // `rel` deliberately persists across tabs/characters (like `upto`): deleting
  // it would make the derived value fall back to the load-time default, and
  // the debounced prefs write would then clobber a choice made this session.
  const changeRelView = useCallback(
    (v: RelViewId) => updateParams((p) => p.set("rel", v), true),
    [updateParams]
  );
  const changeTab = useCallback(
    (t: TabId) =>
      updateParams((p) => {
        p.set("tab", t);
        p.delete("character");
      }, true),
    [updateParams]
  );

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

  const allCharacters = useMemo(() => (ready ? charactersAsOf(ready.thread, cap) : []), [ready, cap]);

  const characters = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCharacters;
    return allCharacters.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q))
    );
  }, [allCharacters, query]);

  // Graph inputs: canonical spoiler-safe identity for every character visible
  // at the cap (unfiltered — the search box must not shrink the graph), plus
  // the cap-filtered edge list.
  const nodeCatalog = useMemo<NodeCatalog>(
    () => new Map(allCharacters.map((c) => [c.id, { name: c.name, role: c.role }])),
    [allCharacters]
  );
  const relEdges = useMemo(() => (ready ? relationshipEdgesAsOf(ready.thread, cap) : []), [ready, cap]);

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
        <div className={styles.crumbRow}>
          <p className={styles.crumb}>
            <Link to="/">← Library</Link>
          </p>
          <ThemeToggle />
        </div>
        <p className={styles.muted}>Loading…</p>
      </main>
    );
  }
  if (state.status === "missing" || state.status === "error" || state.status === "empty") {
    return (
      <main className={styles.page}>
        <div className={styles.crumbRow}>
          <p className={styles.crumb}>
            <Link to="/">← Library</Link>
          </p>
          <ThemeToggle />
        </div>
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
      <div className={styles.crumbRow}>
        <p className={styles.crumb}>
          <Link to="/">← Library</Link>
        </p>
        <ThemeToggle />
      </div>
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

      {character &&
        (detail ? (
          <CharacterDetail
            detail={detail}
            relationships={detailRels}
            events={detailEvents}
            relView={relView}
            onChangeRelView={changeRelView}
            catalog={nodeCatalog}
            edges={relEdges}
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
        ))}
      {/* Both tabs stay mounted and are toggled with `hidden` so switching is a
          pure display flip — remounting the big subtrees caused a visible
          flicker, and this also preserves collapse state across switches. */}
      <div hidden={character !== null || tab !== "characters"}>
        <CharactersTab characters={characters} onSelect={selectCharacter} chapterLabel={chapterLabel} />
      </div>
      <div hidden={character !== null || tab !== "timeline"}>
        <TimelineTab events={events} onSelectCharacter={selectCharacter} chapterLabel={chapterLabel} />
      </div>
    </main>
  );
}
