import type { EventView } from "../lib/asOf";
import { SIGNIFICANCE_ORDER } from "../lib/constants";
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
  onSelectCharacter,
  chapterLabel,
}: {
  events: EventView[];
  onSelectCharacter: (id: string) => void;
  chapterLabel: (index: number) => string;
}) {
  if (events.length === 0) {
    return <p className={styles.empty}>No events yet at this point in the book.</p>;
  }

  const groups = groupByChapter(events);

  return (
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
                <span className={`${styles.dot} ${styles[e.significance]}`} title={e.significance} aria-hidden />
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
  );
}
