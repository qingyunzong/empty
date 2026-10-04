/**
 * Core tree model: nodes keyed by ID, each holding a parent pointer.
 * The root is the only node with a null parent and can never be moved,
 * deleted, or created by a merge.
 */

export type NodeId = string;

export interface Tree {
  readonly rootId: NodeId;
  /** parent of every node; root maps to null. */
  readonly parent: ReadonlyMap<NodeId, NodeId | null>;
}

/** Build a tree from a root id and [child, parent] edges. Throws on duplicates or unknown parents. */
export function makeTree(rootId: NodeId, edges: ReadonlyArray<readonly [NodeId, NodeId]>): Tree {
  const parent = new Map<NodeId, NodeId | null>();
  parent.set(rootId, null);
  for (const [child, p] of edges) {
    if (child === rootId) throw new Error(`root ${rootId} cannot have a parent`);
    if (parent.has(child)) throw new Error(`duplicate node ${child}`);
    parent.set(child, p);
  }
  for (const p of parent.values()) {
    if (p !== null && !parent.has(p)) throw new Error(`unknown parent ${p}`);
  }
  const tree: Tree = { rootId, parent };
  if (findCycle(parent) !== null) throw new Error("edges form a cycle");
  for (const id of parent.keys()) {
    if (id !== rootId && !isReachable(tree, id, rootId)) {
      throw new Error(`node ${id} is not connected to root ${rootId}`);
    }
  }
  return tree;
}

function isReachable(tree: Tree, from: NodeId, to: NodeId): boolean {
  let cur: NodeId | null = from;
  const seen = new Set<NodeId>();
  while (cur !== null) {
    if (cur === to) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = tree.parent.get(cur) ?? null;
  }
  return false;
}

/** Ids of the direct children of `id`, in insertion order of the parent map. */
export function childrenOf(tree: Tree, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (const [node, p] of tree.parent) {
    if (p === id) out.push(node);
  }
  return out;
}

/** All nodes in the subtree rooted at `id`, including `id` itself. */
export function subtreeOf(tree: Tree, id: NodeId): Set<NodeId> {
  const out = new Set<NodeId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [node, p] of tree.parent) {
      if (p !== null && out.has(p) && !out.has(node)) {
        out.add(node);
        grew = true;
      }
    }
  }
  return out;
}

/** True when `ancestor` is a strict ancestor of `id` (or equal to it). */
export function isSelfOrAncestor(tree: Tree, ancestor: NodeId, id: NodeId): boolean {
  let cur: NodeId | null = id;
  const seen = new Set<NodeId>();
  while (cur !== null) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = tree.parent.get(cur) ?? null;
  }
  return false;
}

/**
 * Find one cycle in a child -> parent map.
 * Returns the cycle nodes in edge order (cycle[i]'s parent is cycle[i+1],
 * and the last node's parent is cycle[0]), or null when acyclic.
 */
export function findCycle(parent: ReadonlyMap<NodeId, NodeId | null>): NodeId[] | null {
  const state = new Map<NodeId, 1 | 2>(); // 1 = on current walk, 2 = fully explored
  for (const start of parent.keys()) {
    if (state.has(start)) continue;
    const path: NodeId[] = [];
    const index = new Map<NodeId, number>();
    let cur: NodeId | null = start;
    while (cur !== null && parent.has(cur)) {
      const seen = state.get(cur);
      if (seen === 2) break;
      const at = index.get(cur);
      if (at !== undefined) return path.slice(at);
      index.set(cur, path.length);
      path.push(cur);
      state.set(cur, 1);
      cur = parent.get(cur) ?? null;
    }
    for (const id of path) state.set(id, 2);
  }
  return null;
}
