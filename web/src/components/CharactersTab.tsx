import type { CharacterView } from "../lib/asOf";
import { ROLE_LABELS, ROLE_ORDER } from "../lib/constants";
import styles from "./CharactersTab.module.css";

export default function CharactersTab({
  characters,
  query,
  onSelect,
  chapterLabel,
}: {
  characters: CharacterView[];
  query: string;
  onSelect: (id: string) => void;
  chapterLabel: (index: number) => string;
}) {
  // The tab is handed the cap-filtered list and narrows it itself, so the two
  // empty states below stay distinguishable. Filtering in the caller collapses
  // them: a query that matches nothing arrives here as an empty list and reads
  // as "you haven't got this far in the book yet".
  const q = query.trim().toLowerCase();
  const matches = q
    ? characters.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.aliases.some((a) => a.toLowerCase().includes(q))
      )
    : characters;

  if (characters.length === 0) {
    return <p className={styles.empty}>No characters known yet at this point in the book.</p>;
  }
  if (matches.length === 0) {
    return <p className={styles.empty}>No characters match “{query.trim()}”.</p>;
  }

  return (
    <div className={styles.groups}>
      {ROLE_ORDER.map((role) => {
        const inRole = matches.filter((c) => c.role === role);
        if (inRole.length === 0) return null;
        return (
          <details key={role} className={styles.group} open>
            <summary className={styles.groupTitle}>
              <span className={styles.chevron} aria-hidden />
              {ROLE_LABELS[role]}
              <span className={styles.groupCount}>{inRole.length}</span>
            </summary>
            <ul className={styles.cards}>
              {inRole.map((c) => (
                <li key={c.id}>
                  <button className={styles.card} onClick={() => onSelect(c.id)}>
                    <span className={styles.name}>{c.name}</span>
                    <span className={styles.firstSeen}>First seen · {chapterLabel(c.firstSeenChapterIndex)}</span>
                    {c.description && <span className={styles.desc}>{c.description}</span>}
                    {c.aliases.length > 0 && (
                      <span className={styles.aliases}>
                        {c.aliases.map((a) => (
                          <span key={a} className={styles.alias}>
                            {a}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
