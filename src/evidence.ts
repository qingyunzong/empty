import { graphNodes, type SymbolGraph, type SymbolId } from "./graph.ts";

/**
 * Enumerate every simple "referenced-by" path from `from` to `to` in `graph`
 * (i.e. paths following reverse reference edges). Intended for small graphs:
 * used in tests to independently verify that reported impact chains are
 * genuine shortest paths.
 */
export function enumerateImpactPaths(
  graph: SymbolGraph,
  from: SymbolId,
  to: SymbolId,
): SymbolId[][] {
  const rev = new Map<SymbolId, SymbolId[]>();
  for (const id of graphNodes(graph)) rev.set(id, []);
  for (const [referrer, tos] of graph.edges) {
    for (const target of tos) rev.get(target)!.push(referrer);
  }

  const paths: SymbolId[][] = [];
  const stack: SymbolId[] = [from];
  const onPath = new Set<SymbolId>([from]);

  const visit = (cur: SymbolId): void => {
    if (cur === to) {
      paths.push([...stack]);
      return;
    }
    for (const next of rev.get(cur) ?? []) {
      if (onPath.has(next)) continue;
      onPath.add(next);
      stack.push(next);
      visit(next);
      stack.pop();
      onPath.delete(next);
    }
  };
  visit(from);
  return paths;
}
