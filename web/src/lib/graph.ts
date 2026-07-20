import type { CharacterRole } from "@pipeline/types";
import type { RelationshipEdgeView } from "./asOf";

// Pure derivation of the ego-network subgraph the relationship graph renders.
// No DOM, no d3 — the force simulation consumes this module's output.

export interface GraphNodeView {
  id: string;
  name: string;
  // null when the character record itself isn't visible at the cap (the edge
  // statement mentioned them, but they have no surviving appearance yet).
  role: CharacterRole | null;
}

export interface EgoSubgraph {
  nodes: GraphNodeView[];
  edges: RelationshipEdgeView[];
}

// id -> spoiler-safe display identity, built from *unfiltered*
// charactersAsOf output (never the search-filtered list).
export type NodeCatalog = ReadonlyMap<string, { name: string; role: CharacterRole }>;

// Visibility is a BFS from the root through expanded nodes: a node is visible
// iff it is the root or a direct neighbor of a visible AND expanded node (the
// root always expands). Collapsing a node therefore prunes everything
// reachable only through it, even if descendant ids linger in expandedIds —
// stale ids are harmless. Visible edges are those with both endpoints
// visible, so triangles among neighbors show up.
export function deriveEgoSubgraph(
  catalog: NodeCatalog,
  edges: readonly RelationshipEdgeView[],
  rootId: string,
  expandedIds: ReadonlySet<string>
): EgoSubgraph {
  const neighbors = new Map<string, Set<string>>();
  const edgeName = new Map<string, string>();
  for (const e of edges) {
    let a = neighbors.get(e.aId);
    if (!a) neighbors.set(e.aId, (a = new Set()));
    let b = neighbors.get(e.bId);
    if (!b) neighbors.set(e.bId, (b = new Set()));
    a.add(e.bId);
    b.add(e.aId);
    if (!edgeName.has(e.aId)) edgeName.set(e.aId, e.aName);
    if (!edgeName.has(e.bId)) edgeName.set(e.bId, e.bName);
  }

  const visible = new Set<string>([rootId]);
  // Queue holds visible nodes whose neighborhoods should be revealed.
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const n of neighbors.get(id) ?? []) {
      if (!visible.has(n)) {
        visible.add(n);
        if (expandedIds.has(n)) queue.push(n);
      }
    }
  }

  const nodes = [...visible]
    .map((id): GraphNodeView => {
      const known = catalog.get(id);
      return known
        ? { id, name: known.name, role: known.role }
        : { id, name: edgeName.get(id) ?? id, role: null };
    })
    .sort((a, b) => {
      if (a.id === rootId) return -1;
      if (b.id === rootId) return 1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });

  return {
    nodes,
    edges: edges.filter((e) => visible.has(e.aId) && visible.has(e.bId)),
  };
}

// The node's total relationship count in the cap-filtered edge list (not just
// currently visible edges) — what the panel's expand button reports.
export function neighborCount(edges: readonly RelationshipEdgeView[], id: string): number {
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.aId === id) seen.add(e.bId);
    else if (e.bId === id) seen.add(e.aId);
  }
  return seen.size;
}
