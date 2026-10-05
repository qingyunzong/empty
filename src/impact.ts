import { SymbolGraph, type SymbolId } from "./graph.js";

export interface ChangeSet {
  /** Modified or newly added symbols; evaluated against the new graph. */
  changed?: readonly SymbolId[];
  /** Removed symbols; evaluated against the old graph so their impact is retained. */
  deleted?: readonly SymbolId[];
}

export type GraphSide = "old" | "new";

export interface ImpactChain {
  /** Public entry point that is affected. */
  entry: SymbolId;
  /** Changed/deleted symbol that triggers the impact. */
  trigger: SymbolId;
  /** Reference chain from the entry down to the trigger: [entry, ..., trigger]. */
  chain: SymbolId[];
  /** Which graph produced this chain. */
  source: GraphSide;
}

export interface ImpactReport {
  /** One shortest chain per affected public entry, sorted by entry id. */
  entries: ImpactChain[];
}

function compareChains(a: readonly SymbolId[], b: readonly SymbolId[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * BFS from `trigger` over reversed reference edges. Yields, for every public
 * entry that can reach `trigger`, the shortest chain entry -> ... -> trigger.
 */
export function shortestChainsToEntries(
  trigger: SymbolId,
  graph: SymbolGraph,
): Map<SymbolId, SymbolId[]> {
  const result = new Map<SymbolId, SymbolId[]>();
  if (!graph.has(trigger)) return result;

  const reverse = graph.referencedBy();
  const depth = new Map<SymbolId, number>([[trigger, 0]]);
  const parent = new Map<SymbolId, SymbolId>();
  const queue: SymbolId[] = [trigger];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const currentDepth = depth.get(current)!;
    for (const referrer of reverse.get(current) ?? []) {
      if (depth.has(referrer)) continue;
      depth.set(referrer, currentDepth + 1);
      parent.set(referrer, current);
      queue.push(referrer);
    }
  }

  for (const entry of graph.publicEntries()) {
    if (!depth.has(entry)) continue;
    const chain: SymbolId[] = [entry];
    let cursor = entry;
    while (cursor !== trigger) {
      cursor = parent.get(cursor)!;
      chain.push(cursor);
    }
    result.set(entry, chain);
  }
  return result;
}

function mergeInto(
  best: Map<SymbolId, ImpactChain>,
  trigger: SymbolId,
  source: GraphSide,
  chains: Map<SymbolId, SymbolId[]>,
): void {
  for (const [entry, chain] of chains) {
    const candidate: ImpactChain = { entry, trigger, chain, source };
    const existing = best.get(entry);
    if (!existing) {
      best.set(entry, candidate);
      continue;
    }
    if (chain.length !== existing.chain.length) {
      if (chain.length < existing.chain.length) best.set(entry, candidate);
      continue;
    }
    if (source !== existing.source) {
      if (source === "new") best.set(entry, candidate);
      continue;
    }
    if (compareChains(chain, existing.chain) < 0) best.set(entry, candidate);
  }
}

/**
 * Map a change set to affected public entries. Changed symbols are resolved on
 * the new graph, deleted symbols on the old graph (they no longer exist in the
 * new one), and the report is the union of both sides keeping, per entry, the
 * shortest chain (ties prefer the new graph, then lexicographic order).
 */
export function analyzeImpact(
  oldGraph: SymbolGraph,
  newGraph: SymbolGraph,
  changes: ChangeSet,
): ImpactReport {
  const best = new Map<SymbolId, ImpactChain>();

  for (const trigger of changes.changed ?? []) {
    mergeInto(best, trigger, "new", shortestChainsToEntries(trigger, newGraph));
  }
  for (const trigger of changes.deleted ?? []) {
    mergeInto(best, trigger, "old", shortestChainsToEntries(trigger, oldGraph));
  }

  const entries = [...best.values()].sort((a, b) => (a.entry < b.entry ? -1 : 1));
  return { entries };
}
