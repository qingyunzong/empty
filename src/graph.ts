/**
 * Symbol reference graph.
 *
 * Edge `from -> to` means symbol `from` references (depends on) symbol `to`.
 * Impact therefore propagates along the *reverse* direction: when `to`
 * changes, every `from` that (transitively) references it is impacted.
 */

export type SymbolId = string;

export interface SymbolGraph {
  /** Adjacency list: referrer -> set of referenced symbols. */
  readonly edges: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
  /** Public entry-point symbols (the API surface under review). */
  readonly entries: ReadonlySet<SymbolId>;
}

export function makeGraph(
  edges: Iterable<readonly [SymbolId, SymbolId]>,
  entries: Iterable<SymbolId>,
): SymbolGraph {
  const map = new Map<SymbolId, Set<SymbolId>>();
  const ensure = (id: SymbolId): Set<SymbolId> => {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    return set;
  };
  for (const [from, to] of edges) {
    ensure(from).add(to);
    ensure(to);
  }
  const entrySet = new Set(entries);
  for (const entry of entrySet) ensure(entry);
  return { edges: map, entries: entrySet };
}

export function graphNodes(graph: SymbolGraph): Set<SymbolId> {
  return new Set(graph.edges.keys());
}

/**
 * Union of two graphs: every node and edge present in either graph is kept.
 * This is what lets a *deleted* symbol keep its old-graph impact: the symbol
 * and its old referencers survive in the union even if the new graph dropped
 * them.
 */
export function unionGraph(a: SymbolGraph, b: SymbolGraph): SymbolGraph {
  const edges: Array<readonly [SymbolId, SymbolId]> = [];
  for (const graph of [a, b]) {
    for (const [from, tos] of graph.edges) {
      for (const to of tos) edges.push([from, to]);
    }
  }
  return makeGraph(edges, [...a.entries, ...b.entries]);
}

export interface SymbolDiff {
  /** Present only in the new graph. */
  readonly added: ReadonlySet<SymbolId>;
  /** Present only in the old graph. */
  readonly removed: ReadonlySet<SymbolId>;
  /** Present in both, but with a changed set of outgoing references. */
  readonly modified: ReadonlySet<SymbolId>;
  /** added ∪ removed ∪ modified — the symbols treated as changes. */
  readonly changed: ReadonlySet<SymbolId>;
}

export function diffGraphs(oldGraph: SymbolGraph, newGraph: SymbolGraph): SymbolDiff {
  const oldNodes = graphNodes(oldGraph);
  const newNodes = graphNodes(newGraph);
  const added = new Set<SymbolId>();
  const removed = new Set<SymbolId>();
  const modified = new Set<SymbolId>();

  for (const id of newNodes) if (!oldNodes.has(id)) added.add(id);
  for (const id of oldNodes) if (!newNodes.has(id)) removed.add(id);

  for (const id of oldNodes) {
    if (!newNodes.has(id)) continue;
    const oldOut = oldGraph.edges.get(id) ?? new Set<SymbolId>();
    const newOut = newGraph.edges.get(id) ?? new Set<SymbolId>();
    if (oldOut.size !== newOut.size || [...oldOut].some((to) => !newOut.has(to))) {
      modified.add(id);
    }
  }

  return {
    added,
    removed,
    modified,
    changed: new Set([...added, ...removed, ...modified]),
  };
}
