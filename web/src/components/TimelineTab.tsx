import type { EventView } from "../lib/asOf";
import styles from "./TimelineTab.module.css";

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
    <ol className={styles.timeline}>
      {groups.map((g) => (
        <li key={g.chapterIndex} className={styles.chapter}>
          <div className={styles.chapterHead}>
            {g.chapterTitle ? (
              <span className={styles.chapterTitle}>{g.chapterTitle}</span>
            ) : (
              <span className={styles.chapterNum}>{chapterLabel(g.chapterIndex)}</span>
            )}
          </div>
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
        </li>
      ))}
    </ol>
  );
}
