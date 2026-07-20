import { test } from "node:test";
import assert from "node:assert/strict";
import type { RelationshipEdgeView } from "../src/lib/asOf";
import { deriveEgoSubgraph, neighborCount, type NodeCatalog } from "../src/lib/graph";

// Edge/catalog builders — the subgraph derivation only reads endpoint ids and
// names, so the rest of the view can be boilerplate.
function edge(aId: string, bId: string): RelationshipEdgeView {
  return {
    id: `${aId}--${bId}`,
    aId,
    aName: aId.toUpperCase(),
    bId,
    bName: bId.toUpperCase(),
    type: "knows",
    description: `${aId} knows ${bId}`,
    chapterIndex: 1,
    chapterTitle: "Chapter 1",
    history: [],
  };
}

function catalogOf(...ids: string[]): NodeCatalog {
  return new Map(ids.map((id) => [id, { name: id.toUpperCase(), role: "supporting" as const }]));
}

const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort();
const edgeIds = (g: { edges: { id: string }[] }) => g.edges.map((e) => e.id).sort();

// Chain fixture: root - b - c - d, plus a triangle root - x - y - root.
const CHAIN = [edge("root", "b"), edge("b", "c"), edge("c", "d")];
const TRIANGLE = [edge("root", "x"), edge("root", "y"), edge("x", "y")];

test("root only expanded: direct neighbors visible, nothing deeper", () => {
  const g = deriveEgoSubgraph(catalogOf("root", "b", "c", "d"), CHAIN, "root", new Set(["root"]));
  assert.deepEqual(ids(g), ["b", "root"]);
  assert.deepEqual(edgeIds(g), ["root--b"]);
});

test("a root with zero relationships still yields its node", () => {
  const g = deriveEgoSubgraph(catalogOf("root"), [], "root", new Set(["root"]));
  assert.deepEqual(g.nodes, [{ id: "root", name: "ROOT", role: "supporting" }]);
  assert.deepEqual(g.edges, []);
});

test("expanding a neighbor reveals its neighbors", () => {
  const g = deriveEgoSubgraph(
    catalogOf("root", "b", "c", "d"),
    CHAIN,
    "root",
    new Set(["root", "b"])
  );
  assert.deepEqual(ids(g), ["b", "c", "root"]);
  assert.deepEqual(edgeIds(g), ["b--c", "root--b"]);
});

test("collapse prunes the whole branch even when descendant ids stay expanded", () => {
  // b was collapsed but c remains in expandedIds — c is only reachable
  // through b, so c and d must both disappear.
  const g = deriveEgoSubgraph(
    catalogOf("root", "b", "c", "d"),
    CHAIN,
    "root",
    new Set(["root", "c"])
  );
  assert.deepEqual(ids(g), ["b", "root"]);
  assert.deepEqual(edgeIds(g), ["root--b"]);
});

test("triangle edges among visible neighbors are included", () => {
  // x and y are both direct neighbors of the root; the x--y edge closes the
  // triangle and must be shown even though neither x nor y is expanded.
  const g = deriveEgoSubgraph(catalogOf("root", "x", "y"), TRIANGLE, "root", new Set(["root"]));
  assert.deepEqual(edgeIds(g), ["root--x", "root--y", "x--y"]);
});

test("catalog miss falls back to the edge statement's name with no role", () => {
  const g = deriveEgoSubgraph(catalogOf("root"), [edge("root", "ghost")], "root", new Set(["root"]));
  const ghost = g.nodes.find((n) => n.id === "ghost");
  assert.deepEqual(ghost, { id: "ghost", name: "GHOST", role: null });
});

test("unknown root (not in catalog, no edges) still yields a node", () => {
  const g = deriveEgoSubgraph(catalogOf(), [], "nobody", new Set(["nobody"]));
  assert.deepEqual(g.nodes, [{ id: "nobody", name: "nobody", role: null }]);
});

test("nodes are ordered root first, then by name", () => {
  const g = deriveEgoSubgraph(catalogOf("root", "x", "y"), TRIANGLE, "root", new Set(["root"]));
  assert.deepEqual(
    g.nodes.map((n) => n.id),
    ["root", "x", "y"]
  );
});

test("neighborCount counts distinct partners across the full edge list", () => {
  assert.equal(neighborCount([...CHAIN, ...TRIANGLE], "root"), 3); // b, x, y
  assert.equal(neighborCount(CHAIN, "c"), 2); // b, d
  assert.equal(neighborCount(CHAIN, "nobody"), 0);
});
