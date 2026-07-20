import { useState } from "react";
import type { CharacterDetailView, EventView, RelationshipEdgeView, RelationshipView } from "../lib/asOf";
import type { NodeCatalog } from "../lib/graph";
import type { RelViewId } from "../lib/db";
import { ROLE_LABELS } from "../lib/constants";
import RelationshipGraph from "./RelationshipGraph";
import styles from "./CharacterDetail.module.css";

export default function CharacterDetail({
  detail,
  relationships,
  events,
  relView,
  onChangeRelView,
  catalog,
  edges,
  onSelectCharacter,
  onBack,
  chapterLabel,
}: {
  detail: CharacterDetailView;
  relationships: RelationshipView[];
  events: EventView[];
  relView: RelViewId;
  onChangeRelView: (v: RelViewId) => void;
  catalog: NodeCatalog;
  edges: RelationshipEdgeView[];
  onSelectCharacter: (id: string) => void;
  onBack: () => void;
  chapterLabel: (index: number) => string;
}) {
  // Lazy-mount latch: users who never open the graph pay nothing for it.
  // Once mounted it stays mounted and is `hidden`-toggled (same anti-flicker
  // pattern as the page tabs).
  const [graphMounted, setGraphMounted] = useState(relView === "graph");
  if (relView === "graph" && !graphMounted) setGraphMounted(true);

  return (
    <div className={styles.detail}>
      <button className={styles.back} onClick={onBack}>
        ← All characters
      </button>

      <header className={styles.head}>
        <h2 className={styles.name}>{detail.name}</h2>
        <span className={styles.role}>{ROLE_LABELS[detail.role]}</span>
        <span className={styles.firstSeen}>First seen · {chapterLabel(detail.firstSeenChapterIndex)}</span>
      </header>

      {detail.aliases.length > 0 && (
        <div className={styles.aliases}>
          {detail.aliases.map((a) => (
            <span key={a} className={styles.alias}>
              {a}
            </span>
          ))}
        </div>
      )}

      {detail.description && <p className={styles.bio}>{detail.description}</p>}

      {detail.conflicts.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Progression</h3>
          <ul className={styles.plain}>
            {detail.conflicts.map((c, i) => (
              <li key={`${c.key}-${i}`} className={styles.progression}>
                <span className={styles.progressionKey}>{c.key}</span>
                <span>
                  {c.from.value} <span className={styles.arrow}>→</span> {c.to.value}
                </span>
                <span className={styles.progressionWhen}>
                  {chapterLabel(c.from.chapterIndex)}–{chapterLabel(c.to.chapterIndex)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>
            Relationships<span className={styles.count}>{relationships.length}</span>
          </h3>
          <div className={styles.subTabs} role="tablist" aria-label="Relationships view">
            <button
              role="tab"
              aria-selected={relView === "grid"}
              className={relView === "grid" ? styles.subTabActive : styles.subTab}
              onClick={() => onChangeRelView("grid")}
            >
              Grid
            </button>
            <button
              role="tab"
              aria-selected={relView === "graph"}
              className={relView === "graph" ? styles.subTabActive : styles.subTab}
              onClick={() => onChangeRelView("graph")}
            >
              Graph
            </button>
          </div>
        </div>
        <div hidden={relView !== "grid"}>
          {relationships.length === 0 ? (
            <p className={styles.muted}>No relationships known yet at this point.</p>
          ) : (
            <ul className={styles.relList}>
              {relationships.map((r) => (
                <li key={r.id} className={styles.rel}>
                  <button className={styles.relOther} onClick={() => onSelectCharacter(r.otherId)}>
                    {r.otherName}
                  </button>
                  <span className={styles.relType}>{r.type}</span>
                  {r.description && <p className={styles.relDesc}>{r.description}</p>}
                  <span className={styles.relWhen}>as of {chapterLabel(r.chapterIndex)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {graphMounted && (
          <div hidden={relView !== "graph"}>
            <RelationshipGraph
              key={detail.id}
              rootId={detail.id}
              catalog={catalog}
              edges={edges}
              visible={relView === "graph"}
              onSelectCharacter={onSelectCharacter}
              chapterLabel={chapterLabel}
            />
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>
          How they’re described<span className={styles.count}>{detail.appearances.length}</span>
        </h3>
        <ul className={styles.plain}>
          {detail.appearances.map((a, i) => (
            <li key={`${a.chapterIndex}-${i}`} className={styles.appearance}>
              <span className={styles.appearanceWhen}>{chapterLabel(a.chapterIndex)}</span>
              <span className={styles.appearanceText}>{a.description}</span>
            </li>
          ))}
        </ul>
      </section>

      {events.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            Events<span className={styles.count}>{events.length}</span>
          </h3>
          <ul className={styles.plain}>
            {events.map((e, i) => (
              <li key={`${e.chapterIndex}-${i}`} className={styles.event}>
                <span className={`${styles.dot} ${styles[e.significance]}`} aria-hidden />
                <span className={styles.appearanceWhen}>{chapterLabel(e.chapterIndex)}</span>
                <span className={styles.appearanceText}>{e.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
