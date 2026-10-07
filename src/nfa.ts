import { Seg } from "./pattern";

/**
 * NFA for one pattern. States are 0..stateCount-1, state 0 is the start and
 * state stateCount-1 is the only accepting state. A '**' segment contributes
 * a self any-edge (consume one segment, stay) plus an epsilon edge (skip it).
 * State sets are represented as bit masks in a number (patterns have at most
 * 12 segments, i.e. at most 13 states, so this fits easily).
 */
export interface Nfa {
  stateCount: number;
  finalMask: number;
  eps: number[][]; // epsilon edges: eps[from] -> [to]
  any: number[][]; // edges consuming any one segment: any[from] -> [to]
  lit: Map<string, Array<[number, number]>>; // literal edges
}

export function buildNfa(segs: Seg[]): Nfa {
  const n = segs.length + 1;
  const eps: number[][] = Array.from({ length: n }, () => []);
  const any: number[][] = Array.from({ length: n }, () => []);
  const lit = new Map<string, Array<[number, number]>>();
  segs.forEach((s, i) => {
    if (s.kind === "lit") {
      const edges = lit.get(s.value) ?? [];
      edges.push([i, i + 1]);
      lit.set(s.value, edges);
    } else if (s.kind === "star") {
      any[i]!.push(i + 1);
    } else {
      any[i]!.push(i); // consume one segment, stay
      eps[i]!.push(i + 1); // or skip the ** entirely
    }
  });
  return { stateCount: n, finalMask: 1 << (n - 1), eps, any, lit };
}

/** Epsilon closure of a state set. */
export function closure(nfa: Nfa, mask: number): number {
  const stack: number[] = [];
  let tmp = mask;
  while (tmp !== 0) {
    const bit = tmp & -tmp;
    stack.push(31 - Math.clz32(bit));
    tmp ^= bit;
  }
  let m = mask;
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const t of nfa.eps[s]!) {
      const bit = 1 << t;
      if ((m & bit) === 0) {
        m |= bit;
        stack.push(t);
      }
    }
  }
  return m;
}

/**
 * One step of the subset construction. `literal === null` is the symbolic
 * "other" letter, standing for any segment that is not one of the literals
 * appearing in the rule set; only any-edges ('*' and '**') follow it.
 */
export function step(nfa: Nfa, mask: number, literal: string | null): number {
  let m = 0;
  let tmp = mask;
  while (tmp !== 0) {
    const bit = tmp & -tmp;
    const s = 31 - Math.clz32(bit);
    tmp ^= bit;
    for (const t of nfa.any[s]!) m |= 1 << t;
  }
  if (literal !== null) {
    const edges = nfa.lit.get(literal);
    if (edges) {
      for (const [from, to] of edges) {
        if ((mask & (1 << from)) !== 0) m |= 1 << to;
      }
    }
  }
  return m === 0 ? 0 : closure(nfa, m);
}
