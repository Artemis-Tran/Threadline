import { useMemo, useRef, useState } from "react";
import type { EventSignificance } from "@pipeline/types";
import type { CharacterView, EventView } from "../lib/asOf";
import { useElementSmoothWheel } from "../hooks/useSmoothWheel";
import {
  MAX_LANES,
  STORY_MAP_GEOMETRY as G,
  assignSlots,
  autoLaneIds,
  buildStoryMap,
  type StoryMapLayout,
} from "../lib/storymap";
import styles from "./StoryMap.module.css";

// Vertical storyline chart: lane orders come from the pure layout module;
// this component only maps order slots to x coordinates and draws. The SVG is
// aria-hidden decoration — every interactive target (event rows, "+N more",
// lane labels) is an HTML button overlaid on top of it.

// Horizontal geometry (vertical geometry lives in the layout module).
const RAIL_X = 118; // orphan stations sit on the chapter rail
const LANE_X0 = 170;
const LANE_GAP = 56;
const SVG_W = 445; // overlay text column starts right of this (see .rowText)

const SIG_LABELS: Record<EventSignificance, string> = {
  major: "Major",
  moderate: "Moderate",
  minor: "Minor",
};

function xOf(order: readonly string[], id: string): number | null {
  const i = order.indexOf(id);
  return i === -1 ? null : LANE_X0 + i * LANE_GAP;
}

// Smooth vertical S-curves between consecutive rows (control points at the
// vertical midpoint), straight lines where the lane doesn't move.
function lanePathD(layout: StoryMapLayout, laneId: string): string | null {
  const pts: { x: number; y: number }[] = [];
  const first = xOf(layout.firstOrder, laneId);
  if (first === null) return null;
  pts.push({ x: first, y: G.top - 14 });
  for (const row of layout.rows) {
    const x = xOf(row.order, laneId);
    if (x !== null) pts.push({ x, y: row.y });
  }
  const last = xOf(layout.lastOrder, laneId);
  if (last !== null) pts.push({ x: last, y: layout.totalHeight - 12 });
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const my = (a.y + b.y) / 2;
    d += a.x === b.x ? ` L${b.x},${b.y}` : ` C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
  }
  return d;
}

export default function StoryMap({
  events,
  characters,
  onSelectCharacter,
  chapterLabel,
}: {
  events: EventView[]; // full cap-filtered eventsAsOf output (never search-filtered)
  characters: CharacterView[]; // unfiltered charactersAsOf output
  onSelectCharacter: (id: string) => void;
  chapterLabel: (index: number) => string;
}) {
  const mapScrollRef = useElementSmoothWheel<HTMLDivElement>("both");
  // Global significance filter; major is always on.
  const [sig, setSig] = useState({ moderate: false, minor: false });
  const visibleSignificance = useMemo<ReadonlySet<EventSignificance>>(
    () =>
      new Set<EventSignificance>([
        "major",
        ...(sig.moderate ? (["moderate"] as const) : []),
        ...(sig.minor ? (["minor"] as const) : []),
      ]),
    [sig]
  );

  // Per-chapter reveals, tied to the events array's identity: a cap change
  // produces a new array, which resets the reveals (derived state, no effect)
  // — same spoiler-safe pattern as RelationshipGraph's expansion state.
  const [revealed, setRevealed] = useState<{ events: EventView[]; chapters: ReadonlySet<number> }>(() => ({
    events,
    chapters: new Set<number>(),
  }));
  const fallbackChapters = useMemo<ReadonlySet<number>>(() => new Set<number>(), [events]);
  const revealedChapters = revealed.events === events ? revealed.chapters : fallbackChapters;
  const revealChapter = (chapterIndex: number) => {
    const chapters = new Set(revealedChapters);
    chapters.add(chapterIndex);
    setRevealed({ events, chapters });
  };

  // Lane overrides survive cap changes on purpose (they're the user's picks);
  // lanes referencing characters not visible at the cap simply drop out of
  // the active list until the cap rises again.
  const [laneOverrides, setLaneOverrides] = useState<{ added: readonly string[]; removed: ReadonlySet<string> }>({
    added: [],
    removed: new Set<string>(),
  });
  const charById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const autoIds = useMemo(() => autoLaneIds(characters), [characters]);
  const activeLaneIds = useMemo(() => {
    const ids: string[] = [];
    for (const id of autoIds) {
      if (!laneOverrides.removed.has(id)) ids.push(id);
    }
    for (const id of laneOverrides.added) {
      if (ids.length >= MAX_LANES) break;
      if (!laneOverrides.removed.has(id) && !ids.includes(id) && charById.has(id)) ids.push(id);
    }
    return ids.slice(0, MAX_LANES);
  }, [autoIds, laneOverrides, charById]);

  const removeLane = (id: string) => {
    setLaneOverrides((prev) => ({
      added: prev.added.filter((a) => a !== id),
      removed: new Set(prev.removed).add(id),
    }));
  };
  const addLane = (id: string) => {
    setLaneOverrides((prev) => {
      const removed = new Set(prev.removed);
      removed.delete(id);
      return { added: prev.added.includes(id) ? prev.added : [...prev.added, id], removed };
    });
  };

  // Palette slots: color follows the character while its lane is active.
  const slotRef = useRef<Map<string, number>>(new Map());
  const slots = useMemo(() => {
    const next = assignSlots(activeLaneIds, slotRef.current);
    slotRef.current = next;
    return next;
  }, [activeLaneIds]);
  const laneColor = (id: string) => `var(--lane-${slots.get(id) ?? 1})`;

  const layout = useMemo(
    () => buildStoryMap(events, activeLaneIds, { visibleSignificance, revealedChapters }),
    [events, activeLaneIds, visibleSignificance, revealedChapters]
  );

  // Selection/trace silently expire when their target leaves the visible set.
  const [rawSelected, setRawSelected] = useState<number | null>(null);
  const selectedRow = rawSelected === null ? undefined : layout.rows.find((r) => r.eventIndex === rawSelected);
  const [rawTraced, setRawTraced] = useState<string | null>(null);
  const traced = rawTraced !== null && activeLaneIds.includes(rawTraced) ? rawTraced : null;
  const toggleTrace = (id: string) => setRawTraced((prev) => (prev === id ? null : id));

  if (events.length === 0) {
    return <p className={styles.empty}>No events yet at this point in the book.</p>;
  }

  const addCandidates = characters.filter((c) => !activeLaneIds.includes(c.id));

  return (
    <div>
      <div className={styles.controls}>
        <div className={styles.ctlGroup}>
          <span className={styles.ctlCaption}>Impact</span>
          <span className={styles.chipStatic}>
            <span className={`${styles.swatch} ${styles.major}`} aria-hidden />
            Major
          </span>
          <button
            className={sig.moderate ? styles.chip : styles.chipOff}
            aria-pressed={sig.moderate}
            onClick={() => setSig((s) => ({ ...s, moderate: !s.moderate }))}
          >
            <span className={`${styles.swatch} ${styles.moderate}`} aria-hidden />
            Moderate
          </button>
          <button
            className={sig.minor ? styles.chip : styles.chipOff}
            aria-pressed={sig.minor}
            onClick={() => setSig((s) => ({ ...s, minor: !s.minor }))}
          >
            <span className={`${styles.swatch} ${styles.minor}`} aria-hidden />
            Minor
          </button>
        </div>
        <div className={styles.ctlGroup}>
          <span className={styles.ctlCaption}>Lanes</span>
          {activeLaneIds.map((id) => {
            const name = charById.get(id)?.name ?? id;
            return (
              <span key={id} className={traced === id ? styles.chipTraced : styles.chip}>
                <span className={styles.swatch} style={{ background: laneColor(id) }} aria-hidden />
                <button className={styles.chipName} aria-pressed={traced === id} onClick={() => toggleTrace(id)}>
                  {name}
                </button>
                <button className={styles.chipRemove} aria-label={`Remove ${name} lane`} onClick={() => removeLane(id)}>
                  ×
                </button>
              </span>
            );
          })}
          {activeLaneIds.length < MAX_LANES ? (
            <select
              className={styles.addLane}
              value=""
              aria-label="Add lane"
              onChange={(e) => {
                if (e.target.value) addLane(e.target.value);
              }}
            >
              <option value="">Add lane…</option>
              {addCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span className={styles.laneHint}>Max {MAX_LANES} lanes — remove one to add another</span>
          )}
        </div>
      </div>

      <div ref={mapScrollRef} className={styles.mapScroll}>
        <div className={styles.mapInner} style={{ height: layout.totalHeight }}>
          <svg
            className={traced !== null ? styles.dimmed : undefined}
            width={SVG_W}
            height={layout.totalHeight}
            aria-hidden
          >
            {layout.chapterMarks.map((m) => (
              <line key={m.chapterIndex} className={styles.chRule} x1={10} y1={m.y + 4} x2={SVG_W - 6} y2={m.y + 4} />
            ))}
            {activeLaneIds.map((id) => {
              const d = lanePathD(layout, id);
              if (d === null) return null;
              return (
                <path
                  key={id}
                  className={traced === id ? `${styles.lanePath} ${styles.traced}` : styles.lanePath}
                  d={d}
                  stroke={laneColor(id)}
                />
              );
            })}
            {layout.rows.map((row) => {
              const isSelected = selectedRow?.eventIndex === row.eventIndex;
              const select = () => setRawSelected(row.eventIndex);
              const xs = row.lanedParticipantIds
                .map((id) => xOf(row.order, id))
                .filter((x): x is number => x !== null);
              if (xs.length > 0) {
                const x0 = Math.min(...xs) - 9;
                const x1 = Math.max(...xs) + 9;
                return (
                  <g key={row.eventIndex}>
                    <rect
                      className={isSelected ? styles.stationSelected : styles.station}
                      x={x0}
                      y={row.y - 8}
                      width={x1 - x0}
                      height={16}
                      rx={8}
                      onClick={select}
                    />
                    {row.lanedParticipantIds.map((id) => {
                      const x = xOf(row.order, id);
                      return x === null ? null : (
                        <circle key={id} className={styles.laneDot} cx={x} cy={row.y} r={4.5} fill={laneColor(id)} />
                      );
                    })}
                    <line className={styles.leader} x1={x1 + 4} y1={row.y} x2={SVG_W - 4} y2={row.y} />
                  </g>
                );
              }
              return (
                <g key={row.eventIndex}>
                  <circle
                    className={`${styles.orphan} ${styles[row.event.significance]}`}
                    cx={RAIL_X}
                    cy={row.y}
                    r={6.5}
                    onClick={select}
                  />
                  <line className={styles.leader} x1={RAIL_X + 12} y1={row.y} x2={SVG_W - 4} y2={row.y} />
                </g>
              );
            })}
          </svg>

          {layout.chapterMarks.map((m) => (
            <div key={m.chapterIndex} className={styles.chLabel} style={{ top: m.y + 8 }}>
              {chapterLabel(m.chapterIndex)}
            </div>
          ))}
          {layout.chapterMarks.map((m) =>
            m.moreY === null ? null : (
              <button
                key={m.chapterIndex}
                className={styles.moreBtn}
                style={{ top: m.moreY + 2 }}
                onClick={() => revealChapter(m.chapterIndex)}
              >
                +{m.hiddenCount} more
              </button>
            )
          )}
          {layout.rows.map((row) => (
            <button
              key={row.eventIndex}
              className={selectedRow?.eventIndex === row.eventIndex ? styles.rowTextSelected : styles.rowText}
              style={{ top: row.y - 18 }}
              onClick={() => setRawSelected(row.eventIndex)}
            >
              <span className={`${styles.rowDot} ${styles[row.event.significance]}`} aria-hidden />
              <span className={styles.rowSummary}>{row.event.summary}</span>
            </button>
          ))}
          {activeLaneIds.map((id) => {
            const x = xOf(layout.firstOrder, id);
            return x === null ? null : (
              <button
                key={id}
                className={styles.laneTopLabel}
                style={{ left: x - 2, top: G.top - 34, color: laneColor(id) }}
                aria-pressed={traced === id}
                onClick={() => toggleTrace(id)}
              >
                {charById.get(id)?.name.toUpperCase() ?? id}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.panel} aria-live="polite">
        {selectedRow ? (
          <div>
            <div className={styles.panelHead}>
              <span className={styles.panelWhen}>{chapterLabel(selectedRow.event.chapterIndex)}</span>
              <span
                className={
                  selectedRow.event.significance === "major"
                    ? `${styles.panelSig} ${styles.major}`
                    : styles.panelSig
                }
              >
                {SIG_LABELS[selectedRow.event.significance]}
              </span>
            </div>
            <p className={styles.panelSummary}>{selectedRow.event.summary}</p>
            {selectedRow.event.participants.length > 0 && (
              <div className={styles.panelChips}>
                {selectedRow.event.participants.map((p, i) =>
                  p.id === null ? (
                    <span key={i} className={styles.panelChipPlain}>
                      {p.name}
                    </span>
                  ) : (
                    <button key={i} className={styles.panelChip} onClick={() => onSelectCharacter(p.id!)}>
                      {slots.has(p.id) && (
                        <span className={styles.swatch} style={{ background: laneColor(p.id) }} aria-hidden />
                      )}
                      {p.name}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ) : (
          <p className={styles.panelHint}>
            Click an event station or its summary for details. Click a lane name to trace that character through
            the story.
          </p>
        )}
      </div>
    </div>
  );
}
