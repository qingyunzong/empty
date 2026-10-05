import {
  diffGraphs,
  graphNodes,
  unionGraph,
  type SymbolGraph,
  type SymbolId,
} from "./graph.ts";

export interface ImpactChain {
  /** The public entry point that is impacted. */
  readonly entry: SymbolId;
  /** The changed symbol at the root of the impact. */
  readonly changed: SymbolId;
  /**
   * Shortest witness path, ordered from the changed symbol up to the entry
   * point: `chain[0] === changed`, `chain[chain.length - 1] === entry`.
   * Each step `chain[i] -> chain[i+1]` means "is referenced by".
   */
  readonly chain: readonly SymbolId[];
}

export interface ImpactReport {
  /** Union of the old and new graphs; the graph all chains live in. */
  readonly union: SymbolGraph;
  readonly changed: ReadonlySet<SymbolId>;
  /** Per public entry point, the shortest impact chain (if impacted). */
  readonly byEntry: ReadonlyMap<SymbolId, ImpactChain>;
  /** Public entries with no impact chain from any changed symbol. */
  readonly unaffectedEntries: readonly SymbolId[];
}

/**
 * Reverse adjacency of `graph`: for each symbol, who directly references it.
 */
function referencers(graph: SymbolGraph): Map<SymbolId, Set<SymbolId>> {
  const rev = new Map<SymbolId, Set<SymbolId>>();
  for (const id of graphNodes(graph)) rev.set(id, new Set());
  for (const [from, tos] of graph.edges) {
    for (const to of tos) rev.get(to)!.add(from);
  }
  return rev;
}

/**
 * BFS from `start` over reverse reference edges; returns the shortest
 * "referenced-by" chain from `start` to each reachable entry point.
 */
function shortestChainsToEntries(
  graph: SymbolGraph,
  start: SymbolId,
): Map<SymbolId, SymbolId[]> {
  const rev = referencers(graph);
  const result = new Map<SymbolId, SymbolId[]>();
  const prev = new Map<SymbolId, SymbolId | null>([[start, null]]);
  const queue: SymbolId[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const next of rev.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  for (const entry of graph.entries) {
    if (!prev.has(entry)) continue;
    const chain: SymbolId[] = [];
    for (let cur: SymbolId | null = entry; cur !== null; cur = prev.get(cur)!) {
      chain.push(cur);
    }
    chain.reverse();
    result.set(entry, chain);
  }
  return result;
}

/**
 * Map the changes between `oldGraph` and `newGraph` onto public entry points.
 *
 * The analysis runs on the union of both graphs, so symbols deleted in the
 * new graph still exert their old-graph impact through their old referencers.
 * For every public entry point the shortest impact chain across all changed
 * symbols is returned.
 */
export function analyzeImpact(
  oldGraph: SymbolGraph,
  newGraph: SymbolGraph,
): ImpactReport {
  const union = unionGraph(oldGraph, newGraph);
  const { changed } = diffGraphs(oldGraph, newGraph);

  const byEntry = new Map<SymbolId, ImpactChain>();
  for (const changedSymbol of changed) {
    const chains = shortestChainsToEntries(union, changedSymbol);
    for (const [entry, chain] of chains) {
      const best = byEntry.get(entry);
      if (
        !best ||
        chain.length < best.chain.length ||
        (chain.length === best.chain.length &&
          (changedSymbol < best.changed ||
            (changedSymbol === best.changed &&
              chain.join("") < best.chain.join(""))))
      ) {
        byEntry.set(entry, { entry, changed: changedSymbol, chain });
      }
    }
  }

  const unaffectedEntries = [...union.entries].filter((e) => !byEntry.has(e)).sort();
  return { union, changed, byEntry, unaffectedEntries };
}
