import { edgeCost, validateNetwork } from "./graph";
import { NetworkSpec } from "./types";

const ENUMERATION_LIMIT = 5_000_000;

export interface EnumerationResult {
  /** Min cost of exactly k units for k = 0..amount; null when infeasible. */
  costByAmount: (number | null)[];
  /** Best (value, cost) pair over all k <= amount. */
  bestAtMost: { sent: number; cost: number } | null;
  combinations: number;
}

/**
 * Brute-force enumeration of every integral edge-flow assignment. Intended
 * as an independent cross-check of the solver on small networks.
 */
export function enumerateFlows(rawSpec: NetworkSpec): EnumerationResult {
  const spec = validateNetwork(rawSpec);
  const nodes = spec.nodes!;
  const edges = spec.edges;
  const bounds = edges.map((e) => Math.min(e.capacity, spec.amount));
  const combinations = bounds.reduce((acc, b) => acc * (b + 1), 1);
  if (combinations > ENUMERATION_LIMIT) {
    throw new Error(
      `enumeration would explore ${combinations} assignments (limit ${ENUMERATION_LIMIT}); network too large`
    );
  }

  const costByAmount: (number | null)[] = new Array<number | null>(spec.amount + 1).fill(null);
  const assignment = new Array<number>(edges.length).fill(0);

  const visit = (i: number): void => {
    if (i === edges.length) {
      const balance = new Map<string, number>();
      let cost = 0;
      for (let e = 0; e < edges.length; e++) {
        const flow = assignment[e]!;
        if (flow === 0) continue;
        const edge = edges[e]!;
        balance.set(edge.from, (balance.get(edge.from) ?? 0) + flow);
        balance.set(edge.to, (balance.get(edge.to) ?? 0) - flow);
        cost += edgeCost(edge.segments, flow);
      }
      const sent = balance.get(spec.source) ?? 0;
      if (sent < 0 || sent > spec.amount) return;
      let feasible = (balance.get(spec.sink) ?? 0) === -sent;
      if (feasible) {
        for (const node of nodes) {
          if (node === spec.source || node === spec.sink) continue;
          if ((balance.get(node) ?? 0) !== 0) {
            feasible = false;
            break;
          }
        }
      }
      if (!feasible) return;
      const current = costByAmount[sent]!;
      if (current === null || cost < current) costByAmount[sent] = cost;
      return;
    }
    for (let flow = 0; flow <= bounds[i]!; flow++) {
      assignment[i] = flow;
      visit(i + 1);
    }
  };
  visit(0);

  let bestAtMost: { sent: number; cost: number } | null = null;
  for (let k = 0; k <= spec.amount; k++) {
    const cost = costByAmount[k]!;
    if (cost !== null && (bestAtMost === null || cost < bestAtMost.cost)) {
      bestAtMost = { sent: k, cost };
    }
  }
  return { costByAmount, bestAtMost, combinations };
}
