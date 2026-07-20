import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { CharacterRole } from "@pipeline/types";
import type { RelationshipEdgeView } from "../lib/asOf";
import { deriveEgoSubgraph, neighborCount, type NodeCatalog } from "../lib/graph";
import { ROLE_LABELS } from "../lib/constants";
import styles from "./RelationshipGraph.module.css";

// Interactive ego-network graph: d3-force does the layout math, React owns
// the SVG. Coordinates live in a centered space (viewBox spans ±w/2 × ±h/2)
// so the simulation never needs to know the rendered size. The root is
// pinned at the origin; weak x/y forces (not forceCenter, which would fight
// the pin) keep everything else on screen.

interface SimNode extends SimulationNodeDatum {
  id: string;
  name: string;
  role: CharacterRole | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  edge: RelationshipEdgeView;
}

type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string };

const ROOT_RADIUS = 10;
const NODE_RADIUS = 7;
// Pointer movement (px) below which a pointerdown+up counts as a click.
const CLICK_SLOP = 4;

function isActivationKey(e: ReactKeyboardEvent): boolean {
  return e.key === "Enter" || e.key === " ";
}

export default function RelationshipGraph({
  rootId,
  catalog,
  edges,
  visible,
  onSelectCharacter,
  chapterLabel,
}: {
  rootId: string;
  catalog: NodeCatalog;
  edges: RelationshipEdgeView[];
  visible: boolean;
  onSelectCharacter: (id: string) => void;
  chapterLabel: (index: number) => string;
}) {
  // Expansion state, tied to the edge list's identity: a cap change produces
  // a new edge array, which resets the expansion to just the root (derived
  // state, no effect) — spoiler-safe by construction and never stale.
  const [expanded, setExpanded] = useState<{ edges: RelationshipEdgeView[]; ids: ReadonlySet<string> }>(
    () => ({ edges, ids: new Set([rootId]) })
  );
  // The fallback must have stable identity: a fresh Set per render would give
  // `sub` a new identity every render, and each simulation tick would then
  // re-run the effect below and reheat the simulation forever.
  const fallbackIds = useMemo<ReadonlySet<string>>(() => new Set([rootId]), [edges, rootId]);
  const expandedIds = expanded.edges === edges ? expanded.ids : fallbackIds;

  const [rawSelection, setRawSelection] = useState<Selection | null>(null);
  const [, setTick] = useState(0);
  const [size, setSize] = useState({ w: 640, h: 420 });

  const sub = useMemo(
    () => deriveEgoSubgraph(catalog, edges, rootId, expandedIds),
    [catalog, edges, rootId, expandedIds]
  );

  // A selection silently expires when its target leaves the subgraph
  // (collapse, cap change) — the panel falls back to the hint text.
  const selection = useMemo<Selection | null>(() => {
    if (!rawSelection) return null;
    if (rawSelection.kind === "node") {
      return sub.nodes.some((n) => n.id === rawSelection.id) ? rawSelection : null;
    }
    return sub.edges.some((e) => e.id === rawSelection.id) ? rawSelection : null;
  }, [rawSelection, sub]);

  // Persistent SimNode objects, keyed by id, so positions (and drag pins)
  // survive expand/collapse and cap changes. Created lazily from render AND
  // the simulation effect via the same idempotent helper, so the first paint
  // already has spread-out positions instead of a one-frame origin flash.
  const nodeMapRef = useRef(new Map<string, SimNode>());
  const ensureSimNode = (id: string, name: string, role: CharacterRole | null): SimNode => {
    const map = nodeMapRef.current;
    let n = map.get(id);
    if (!n) {
      const angle = Math.random() * 2 * Math.PI;
      const radius = 60 + Math.random() * 60;
      n = { id, name, role, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      if (id === rootId) {
        // Pin the root at the origin (a later drag moves the pin).
        n.x = 0;
        n.y = 0;
        n.fx = 0;
        n.fy = 0;
      }
      map.set(id, n);
    } else {
      n.name = name;
      n.role = role;
    }
    return n;
  };

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  // Read by the tick handler (a one-time closure) so clamping always sees the
  // current measured size.
  const sizeRef = useRef(size);

  // Keep every node (plus its label) inside the canvas — the layout has no
  // pan/zoom, so anything past the edge would be unreachable.
  const clampX = (x: number) => {
    const mx = Math.max(60, sizeRef.current.w / 2 - 32);
    return Math.max(-mx, Math.min(mx, x));
  };
  const clampY = (y: number) => {
    const my = Math.max(60, sizeRef.current.h / 2 - 32);
    return Math.max(-my, Math.min(my, y));
  };

  useEffect(() => {
    const nodes = sub.nodes.map((n) => ensureSimNode(n.id, n.name, n.role));
    const links: SimLink[] = sub.edges.map((e) => ({ source: e.aId, target: e.bId, edge: e }));
    let sim = simRef.current;
    const first = sim === null;
    if (!sim) {
      const created: Simulation<SimNode, SimLink> = forceSimulation<SimNode>([])
        .force("charge", forceManyBody().strength(-320))
        .force("x", forceX(0).strength(0.04))
        .force("y", forceY(0).strength(0.06))
        .force("collide", forceCollide<SimNode>(NODE_RADIUS + 22))
        .on("tick", () => {
          for (const nd of created.nodes()) {
            nd.x = clampX(nd.x ?? 0);
            nd.y = clampY(nd.y ?? 0);
          }
          setTick((t) => t + 1);
        });
      sim = created;
      simRef.current = created;
    }
    sim.nodes(nodes);
    sim.force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(120)
        .strength(0.5)
    );
    // Full heat only on first layout; topology changes get a gentle reheat so
    // the existing arrangement adjusts instead of exploding. While hidden,
    // only store the heat — the visibility effect restarts it when shown.
    sim.alpha(first ? 1 : 0.4);
    if (visible) sim.restart();
    else sim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub]);

  useEffect(
    () => () => {
      simRef.current?.stop();
    },
    []
  );

  // A hidden graph must not burn CPU mid-cooldown; resume (if any heat is
  // left) when shown again.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    if (visible) sim.restart();
    else sim.stop();
  }, [visible]);

  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // Ignore the 0×0 measurement while hidden.
      if (r.width > 0 && r.height > 0) {
        sizeRef.current = { w: r.width, h: r.height };
        // Tick-time clamping only runs while the simulation is hot — after it
        // cools, a shrink would strand nodes (and pins) out of bounds, so
        // re-clamp here and reheat gently to let the layout adapt.
        for (const nd of nodeMapRef.current.values()) {
          nd.x = clampX(nd.x ?? 0);
          nd.y = clampY(nd.y ?? 0);
          if (nd.fx != null) nd.fx = clampX(nd.fx);
          if (nd.fy != null) nd.fy = clampY(nd.fy);
        }
        simRef.current?.alpha(0.1).restart();
        setSize(sizeRef.current);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const svgRef = useRef<SVGSVGElement>(null);
  const toSimCoords = (e: ReactPointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
  };

  const dragRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);

  const onNodePointerDown = (id: string) => (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
  };
  const onNodePointerMove = (id: string) => (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < CLICK_SLOP) return;
      drag.moved = true;
      simRef.current?.alphaTarget(0.15).restart();
    }
    const node = nodeMapRef.current.get(id);
    if (node) {
      const p = toSimCoords(e);
      node.fx = clampX(p.x);
      node.fy = clampY(p.y);
    }
  };
  const onNodePointerUp = (id: string) => () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.id !== id) return;
    if (drag.moved) {
      simRef.current?.alphaTarget(0);
    } else {
      // A no-movement press is a click: select. (Dragged nodes stay pinned.)
      setRawSelection({ kind: "node", id });
    }
  };
  // A cancelled/lost drag must not leave alphaTarget raised (the simulation
  // would never cool) or dragRef populated.
  const onNodePointerCancel = () => {
    if (dragRef.current?.moved) simRef.current?.alphaTarget(0);
    dragRef.current = null;
  };

  const toggleExpand = (id: string) => {
    const ids = new Set(expandedIds);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    setExpanded({ edges, ids });
  };

  const unpin = (id: string) => {
    const node = nodeMapRef.current.get(id);
    if (node) {
      node.fx = null;
      node.fy = null;
      simRef.current?.alpha(0.3).restart();
    }
  };

  const selectedNode = selection?.kind === "node" ? sub.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? sub.edges.find((e) => e.id === selection.id) : undefined;
  const nodeEdges = selectedNode
    ? sub.edges.filter((e) => e.aId === selectedNode.id || e.bId === selectedNode.id)
    : [];
  const selectedSimNode = selectedNode ? nodeMapRef.current.get(selectedNode.id) : undefined;

  return (
    <div className={styles.wrap}>
      <div ref={wrapRef} className={styles.canvas}>
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
          // group, not img: an img role would flatten the interactive node/
          // edge descendants out of the accessibility tree.
          role="group"
          aria-label="Relationship graph"
        >
          {sub.edges.map((e) => {
            // Endpoints are always in sub.nodes, so the node loop (and the
            // simulation effect) own creation; this is a position read only.
            const a = nodeMapRef.current.get(e.aId) ?? { x: 0, y: 0 };
            const b = nodeMapRef.current.get(e.bId) ?? { x: 0, y: 0 };
            const isSelected = selection?.kind === "edge" && selection.id === e.id;
            const select = () => setRawSelection({ kind: "edge", id: e.id });
            return (
              <g
                key={e.id}
                className={isSelected ? styles.edgeSelected : styles.edge}
                role="button"
                tabIndex={0}
                aria-label={`${e.aName} and ${e.bName}: ${e.type}`}
                onClick={select}
                onKeyDown={(k) => {
                  if (isActivationKey(k)) {
                    k.preventDefault();
                    select();
                  }
                }}
              >
                {/* Invisible widened stroke so the thin line is clickable. */}
                <line className={styles.edgeHit} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <line className={styles.edgeLine} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <text className={styles.edgeLabel} x={((a.x ?? 0) + (b.x ?? 0)) / 2} y={((a.y ?? 0) + (b.y ?? 0)) / 2 - 4}>
                  {e.type}
                </text>
              </g>
            );
          })}
          {sub.nodes.map((n) => {
            const simNode = ensureSimNode(n.id, n.name, n.role);
            const isRoot = n.id === rootId;
            const isSelected = selection?.kind === "node" && selection.id === n.id;
            const r = isRoot ? ROOT_RADIUS : NODE_RADIUS;
            return (
              <g
                key={n.id}
                className={styles.node}
                transform={`translate(${simNode.x ?? 0},${simNode.y ?? 0})`}
                role="button"
                tabIndex={0}
                aria-label={n.name}
                onPointerDown={onNodePointerDown(n.id)}
                onPointerMove={onNodePointerMove(n.id)}
                onPointerUp={onNodePointerUp(n.id)}
                onPointerCancel={onNodePointerCancel}
                onLostPointerCapture={onNodePointerCancel}
                onKeyDown={(k) => {
                  if (isActivationKey(k)) {
                    k.preventDefault();
                    setRawSelection({ kind: "node", id: n.id });
                  }
                }}
              >
                <circle
                  r={r}
                  className={[
                    isRoot ? styles.circleRoot : styles.circle,
                    isSelected ? styles.circleSelected : "",
                  ].join(" ")}
                />
                <text className={styles.nodeLabel} y={r + 13}>
                  {n.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className={styles.panel} aria-live="polite">
        {selectedNode ? (
          <div className={styles.panelBody}>
            <div className={styles.panelHead}>
              <span className={styles.panelName}>{selectedNode.name}</span>
              {selectedNode.role && <span className={styles.panelRole}>{ROLE_LABELS[selectedNode.role]}</span>}
            </div>
            <div className={styles.panelActions}>
              {selectedNode.id !== rootId && neighborCount(edges, selectedNode.id) > 0 && (
                <button className={styles.panelBtn} onClick={() => toggleExpand(selectedNode.id)}>
                  {expandedIds.has(selectedNode.id) ? "Collapse neighbors" : `Expand neighbors (${neighborCount(edges, selectedNode.id)})`}
                </button>
              )}
              {selectedNode.role !== null && (
                <button className={styles.panelBtn} onClick={() => onSelectCharacter(selectedNode.id)}>
                  Open page
                </button>
              )}
              {selectedNode.id !== rootId && selectedSimNode?.fx != null && (
                <button className={styles.panelBtn} onClick={() => unpin(selectedNode.id)}>
                  Unpin
                </button>
              )}
            </div>
            {nodeEdges.length > 0 && (
              <ul className={styles.panelList}>
                {nodeEdges.map((e) => (
                  <li key={e.id}>
                    <button className={styles.panelLink} onClick={() => setRawSelection({ kind: "edge", id: e.id })}>
                      {e.aId === selectedNode.id ? e.bName : e.aName}
                      <span className={styles.panelType}>{e.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : selectedEdge ? (
          <div className={styles.panelBody}>
            <div className={styles.panelHead}>
              <span className={styles.panelName}>
                {selectedEdge.aName} <span className={styles.panelSep}>&harr;</span> {selectedEdge.bName}
              </span>
              <span className={styles.panelRole}>{selectedEdge.type}</span>
            </div>
            {selectedEdge.description && <p className={styles.panelDesc}>{selectedEdge.description}</p>}
            <ul className={styles.panelHistory}>
              {selectedEdge.history.map((s, i) => (
                <li key={`${s.chapterIndex}-${i}`} className={styles.panelHistoryItem}>
                  <span className={styles.panelWhen}>{chapterLabel(s.chapterIndex)}</span>
                  <span>
                    <span className={styles.panelType}>{s.type}</span> {s.description}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className={styles.panelHint}>
            Click a character or relationship for details. Drag characters to rearrange — dragged ones stay
            put.
          </p>
        )}
      </div>
    </div>
  );
}
