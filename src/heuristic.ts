/**
 * Admissible heuristic lower bounds and A* search.
 *
 * The bound is h_max over the individual goal conditions, computed on
 * two relaxations of the problem:
 *
 *  - delete relaxation (for "bit must be 1" goals): clear-effects,
 *    forbid-preconditions and resource costs are ignored; trueDist[b]
 *    is the relaxed minimum number of actions to make bit b true.
 *  - add relaxation (for "bit must be 0" goals): set-effects and
 *    require-preconditions are ignored; falseDist[b] is the relaxed
 *    minimum number of actions to make bit b false.
 *
 * h(s) = max over goal conditions of the relaxed distance. Each
 * per-condition relaxed distance never exceeds the true cost of
 * achieving that condition, and any plan must achieve every condition,
 * so h(s) <= h*(s): the bound is admissible. h = Infinity is a sound
 * dead-end proof (each relaxation over-approximates reachable states).
 *
 * The bound is *checkable*: `lowerBound` returns the full distance
 * vectors, and `checkLowerBound` independently recomputes the fixpoint
 * and verifies every reported number, so bounds emitted during search
 * can be audited after the fact.
 */

import { Problem, applyAction, isGoal, stateKey } from "./model.js";

export interface LowerBound {
  /** The admissible lower bound h(s); Infinity = dead end. */
  value: number;
  /** Relaxed min actions to make each bit true (Infinity if impossible). */
  trueDist: number[];
  /** Relaxed min actions to make each bit false (Infinity if impossible). */
  falseDist: number[];
}

function relaxFixpoint(p: Problem, bits: number, mode: "true" | "false"): number[] {
  // mode "true": delete relaxation. A bit becomes true via set-effects;
  //   enablers are requireMask bits (forbidMask ignored).
  // mode "false": add relaxation. A bit becomes false via clear-effects;
  //   enablers are forbidMask bits (requireMask ignored).
  const dist = new Array<number>(p.bits).fill(Infinity);
  for (let b = 0; b < p.bits; b++) {
    const isSet = (bits & (1 << b)) !== 0;
    if ((mode === "true" && isSet) || (mode === "false" && !isSet)) dist[b] = 0;
  }
  const raise = (effMask: number, cost: number): boolean => {
    let changed = false;
    for (let b = 0; b < p.bits; b++) {
      if (effMask & (1 << b)) {
        if (cost < dist[b]!) { dist[b] = cost; changed = true; }
      }
    }
    return changed;
  };
  const enablerCost = (mask: number): number | null => {
    let base = 0;
    for (let b = 0; b < p.bits; b++) {
      if (mask & (1 << b)) {
        const d = dist[b]!;
        if (d === Infinity) return null;
        if (d > base) base = d;
      }
    }
    return base;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of p.actions) {
      const base = enablerCost(mode === "true" ? a.requireMask : a.forbidMask);
      if (base === null) continue;
      if (raise(mode === "true" ? a.setMask : a.clearMask, base + 1)) changed = true;
      for (const c of a.cond) {
        const trig = enablerCost(mode === "true" ? c.requireMask : c.forbidMask);
        if (trig === null) continue;
        const cost = Math.max(base, trig) + 1;
        if (raise(mode === "true" ? c.setMask : c.clearMask, cost)) changed = true;
      }
    }
  }
  return dist;
}

/** Compute the admissible lower bound for the bits part of a state. */
export function lowerBound(p: Problem, bits: number): LowerBound {
  const trueDist = relaxFixpoint(p, bits, "true");
  const falseDist = relaxFixpoint(p, bits, "false");
  let value = 0;
  for (let b = 0; b < p.bits; b++) {
    if (p.goalRequire & (1 << b)) value = Math.max(value, trueDist[b]!);
    if (p.goalForbid & (1 << b)) value = Math.max(value, falseDist[b]!);
  }
  return { value, trueDist, falseDist };
}

/**
 * Independently verify a reported lower bound for `bits`: recompute the
 * relaxation and check that every reported distance and the final value
 * match. Returns true iff the bound certificate is valid.
 */
export function checkLowerBound(p: Problem, bits: number, lb: LowerBound): boolean {
  const recomputed = lowerBound(p, bits);
  const sameDist = (a: number[], b: number[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return (
    sameDist(lb.trueDist, recomputed.trueDist) &&
    sameDist(lb.falseDist, recomputed.falseDist) &&
    lb.value === recomputed.value
  );
}

export interface BoundRecord {
  key: string;
  bits: number;
  g: number;
  h: number;
  f: number;
  /** true when h = Infinity (dead end) caused this node to be pruned. */
  pruned: boolean;
}

export interface AstarResult {
  plan: number[] | null;
  length: number | null;
  expansions: number;
  /** Every lower bound emitted during the search, for auditing. */
  bounds: BoundRecord[];
}

/**
 * A* with the admissible bound above. Unit action costs. Ties break
 * deterministically (higher g first, then insertion order) so runs are
 * reproducible. Nodes with h = Infinity are pruned (sound dead-end
 * detection) and recorded in `bounds`.
 */
export function astar(p: Problem): AstarResult {
  interface Node {
    bits: number;
    res: number[];
    g: number;
    h: number;
    seq: number;
    path: number[];
  }
  const bounds: BoundRecord[] = [];
  const h0 = lowerBound(p, p.initial).value;
  const open: Node[] = [
    { bits: p.initial, res: [...p.initialRes], g: 0, h: h0, seq: 0, path: [] },
  ];
  let seq = 1;
  const bestG = new Map<string, number>();
  bestG.set(stateKey(p.initial, p.initialRes), 0);
  let expansions = 0;

  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[bi]!;
      const fa = a.g + a.h;
      const fb = b.g + b.h;
      if (fa < fb || (fa === fb && (a.g > b.g || (a.g === b.g && a.seq < b.seq)))) bi = i;
    }
    const node = open.splice(bi, 1)[0]!;
    const key = stateKey(node.bits, node.res);
    if ((bestG.get(key) ?? Infinity) < node.g) continue; // stale entry
    if (node.h === Infinity) {
      bounds.push({ key, bits: node.bits, g: node.g, h: Infinity, f: Infinity, pruned: true });
      continue; // sound prune: relaxed problem unsolvable from here
    }
    bounds.push({ key, bits: node.bits, g: node.g, h: node.h, f: node.g + node.h, pruned: false });
    expansions++;
    if (isGoal(p, node.bits)) {
      return { plan: node.path, length: node.g, expansions, bounds };
    }
    for (const a of p.actions) {
      const next = applyAction(p, { bits: node.bits, res: node.res }, a);
      if (!next) continue;
      const g = node.g + 1;
      const nkey = stateKey(next.bits, next.res);
      if ((bestG.get(nkey) ?? Infinity) <= g) continue;
      bestG.set(nkey, g);
      const h = lowerBound(p, next.bits).value;
      open.push({ bits: next.bits, res: next.res, g, h, seq: seq++, path: [...node.path, a.index] });
    }
  }
  return { plan: null, length: null, expansions, bounds };
}
