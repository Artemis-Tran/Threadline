import { useState } from "react";
import type { CharacterView, EventView } from "../lib/asOf";
import type { TimelineViewId } from "../lib/db";
import { SIGNIFICANCE_ORDER } from "../lib/constants";
import StoryMap from "./StoryMap";
import styles from "./TimelineTab.module.css";

const SIGNIFICANCE_LABELS = {
  major: "Major",
  moderate: "Moderate",
  minor: "Minor",
} as const;

interface ChapterGroup {
  chapterIndex: number;
  chapterTitle: string | null;
  events: EventView[];
}

function groupByChapter(events: EventView[]): ChapterGroup[] {
  const groups: ChapterGroup[] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last.chapterIndex === e.chapterIndex) {
      last.events.push(e);
    } else {
      groups.push({ chapterIndex: e.chapterIndex, chapterTitle: e.chapterTitle, events: [e] });
    }
  }
  return groups;
}

export default function TimelineTab({
  events,
  eventsAll,
  characters,
  view,
  onChangeView,
  onSelectCharacter,
  chapterLabel,
}: {
  events: EventView[]; // search-filtered — feeds the List only
  eventsAll: EventView[]; // unfiltered cap output — feeds the Story map only
  characters: CharacterView[];
  view: TimelineViewId;
  onChangeView: (v: TimelineViewId) => void;
  onSelectCharacter: (id: string) => void;
  chapterLabel: (index: number) => string;
}) {
  // Lazy-mount latch: users who never open the map pay nothing for it. Once
  // mounted it stays mounted and is `hidden`-toggled (same anti-flicker
  // pattern as CharacterDetail's relationship graph).
  const [mapMounted, setMapMounted] = useState(view === "map");
  if (view === "map" && !mapMounted) setMapMounted(true);

  const groups = groupByChapter(events);

  return (
    <>
      <div className={styles.subTabs} role="tablist" aria-label="Timeline view">
        <button
          role="tab"
          aria-selected={view === "list"}
          className={view === "list" ? styles.subTabActive : styles.subTab}
          onClick={() => onChangeView("list")}
        >
          List
        </button>
        <button
          role="tab"
          aria-selected={view === "map"}
          className={view === "map" ? styles.subTabActive : styles.subTab}
          onClick={() => onChangeView("map")}
        >
          Story map
        </button>
      </div>
      {mapMounted && (
        <div hidden={view !== "map"}>
          <StoryMap
            events={eventsAll}
            characters={characters}
            onSelectCharacter={onSelectCharacter}
            chapterLabel={chapterLabel}
          />
        </div>
      )}
      <div hidden={view !== "list"}>
        {events.length === 0 ? (
          <p className={styles.empty}>No events yet at this point in the book.</p>
        ) : (
          <>
            <div className={styles.legend}>
              <span className={styles.legendCaption}>Event impact</span>
              {SIGNIFICANCE_ORDER.map((s) => (
                <span key={s} className={styles.legendItem}>
                  <span className={`${styles.previewDot} ${styles[s]}`} aria-hidden />
                  {SIGNIFICANCE_LABELS[s]}
                </span>
              ))}
            </div>
            <ol className={styles.timeline}>
              {groups.map((g) => (
                <li key={g.chapterIndex} className={styles.chapter}>
                  <details className={styles.disclosure}>
                    <summary className={styles.chapterHead}>
                      <span className={styles.railLabel}>
                        <span className={styles.chevron} aria-hidden />
                        <span className={styles.labelStack}>
                          {g.chapterTitle ? (
                            <span className={styles.chapterTitle}>{g.chapterTitle}</span>
                          ) : (
                            <span className={styles.chapterNum}>{chapterLabel(g.chapterIndex)}</span>
                          )}
                          <span className={styles.eventCount}>{g.events.length} events</span>
                        </span>
                      </span>
                      <span className={styles.preview} aria-hidden>
                        <span className={styles.previewDots}>
                          {g.events.map((e, i) => (
                            <span key={i} className={`${styles.previewDot} ${styles[e.significance]}`} />
                          ))}
                        </span>
                      </span>
                    </summary>
                    <ul className={styles.events}>
                      {g.events.map((e, i) => (
                        <li key={i} className={styles.event}>
                          <span
                            className={`${styles.dot} ${styles[e.significance]}`}
                            title={e.significance}
                            aria-hidden
                          />
                          <div className={styles.body}>
                            <p className={styles.summary}>{e.summary}</p>
                            {e.participants.length > 0 && (
                              <div className={styles.chips}>
                                {e.participants.map((p, j) =>
                                  p.id === null ? (
                                    <span key={j} className={styles.chipPlain}>
                                      {p.name}
                                    </span>
                                  ) : (
                                    <button key={j} className={styles.chip} onClick={() => onSelectCharacter(p.id!)}>
                                      {p.name}
                                    </button>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </>
  );
}
