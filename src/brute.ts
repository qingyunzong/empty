import { Problem, edgeCapacity, edgeCost } from "./model";

export interface BruteResult {
  status: "ok" | "infeasible";
  minCost?: number;
  /** Flow per input edge achieving minCost. */
  assignment?: number[];
}

export const ENUMERATION_LIMIT = 5_000_000;

/**
 * Exact min-cost flow by enumerating every integer flow assignment on small
 * networks. Independent of the solver algorithm, so it serves as ground truth
 * in tests. Throws if the search space exceeds ENUMERATION_LIMIT.
 */
export function bruteForce(problem: Problem): BruteResult {
  const m = problem.edges.length;
  // No edge needs to carry more than `amount` units: flow decomposition says
  // any feasible flow splits into s-t paths plus cycles, cycles have
  // non-negative cost (negative cycles are forbidden in the input), so an
  // optimal solution exists with every edge flow <= amount.
  const caps = problem.edges.map((e) => Math.min(edgeCapacity(e), problem.amount));

  let space = 1;
  for (const c of caps) {
    space *= c + 1;
    if (space > ENUMERATION_LIMIT)
      throw new Error(`enumeration space ${space} exceeds limit ${ENUMERATION_LIMIT}`);
  }

  const nodes = new Set<string>();
  nodes.add(problem.source);
  nodes.add(problem.sink);
  for (const e of problem.edges) {
    nodes.add(e.from);
    nodes.add(e.to);
  }

  const flow = new Array<number>(m).fill(0);
  let best: number | null = null;
  let bestAssignment: number[] | null = null;

  const balances = new Map<string, number>();

  function feasible(): boolean {
    balances.clear();
    for (const n of nodes) balances.set(n, 0);
    for (let i = 0; i < m; i++) {
      const e = problem.edges[i]!;
      const f = flow[i]!;
      balances.set(e.from, balances.get(e.from)! - f);
      balances.set(e.to, balances.get(e.to)! + f);
    }
    for (const n of nodes) {
      const b = balances.get(n)!;
      const expected = n === problem.source ? -problem.amount : n === problem.sink ? problem.amount : 0;
      if (b !== expected) return false;
    }
    return true;
  }

  function cost(): number {
    let total = 0;
    for (let i = 0; i < m; i++) total += edgeCost(problem.edges[i]!, flow[i]!);
    return total;
  }

  function enumerate(i: number): void {
    if (i === m) {
      if (!feasible()) return;
      const c = cost();
      if (best === null || c < best) {
        best = c;
        bestAssignment = flow.slice();
      }
      return;
    }
    for (let f = 0; f <= caps[i]!; f++) {
      flow[i] = f;
      enumerate(i + 1);
    }
  }
  enumerate(0);

  if (best === null) return { status: "infeasible" };
  return { status: "ok", minCost: best, assignment: bestAssignment! };
}
