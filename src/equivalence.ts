/**
 * Equivalence checking by BFS over the reachable product configuration
 * space (state1 x state2 x 8-bit registers1 x 8-bit registers2).
 *
 * Because the alphabet is ordered and the queue is FIFO, the first
 * divergence found is a shortest one; ties at the same length are resolved
 * lexicographically (see the `best` candidate logic below).
 *
 * If the configuration budget is exhausted the result is "unknown":
 * equivalence is NOT claimed.
 */

import { Machine } from "./machine";

export interface ProductConfig {
  s1: string;
  s2: string;
  r1: number[];
  r2: number[];
}

export interface Certificate {
  reachableConfigurations: number;
  states1: number;
  states2: number;
  registerBits: number;
  configurations: ProductConfig[];
  truncated: boolean;
}

export type EquivResult =
  | { status: "equivalent"; explored: number; certificate: Certificate }
  | { status: "distinguished"; explored: number; kind: "acceptance" | "output"; word: string[] }
  | { status: "unknown"; explored: number; reason: string };

function lexCompare(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function checkEquivalence(
  m1: Machine,
  m2: Machine,
  initRegs: number[],
  budget: number,
  certLimit = 1000,
): EquivResult {
  interface Node {
    cfg: ProductConfig;
    word: string[];
  }
  const key = (c: ProductConfig): string =>
    `${c.s1}|${c.s2}|${c.r1.join(",")}|${c.r2.join(",")}`;

  const start: ProductConfig = { s1: m1.initial, s2: m2.initial, r1: initRegs.slice(), r2: initRegs.slice() };
  const visited = new Set<string>([key(start)]);
  const queue: Node[] = [{ cfg: start, word: [] }];
  const cert: ProductConfig[] = [];
  let best: { kind: "acceptance" | "output"; word: string[] } | null = null;
  let explored = 0;
  let head = 0;

  while (head < queue.length) {
    const node = queue[head];
    if (best && node.word.length > best.word.length) break;
    if (explored >= budget) {
      return {
        status: "unknown",
        explored,
        reason:
          `state budget exhausted (${budget} configurations); ` +
          `${queue.length - head} configurations still queued - equivalence not established`,
      };
    }
    head++;
    explored++;
    const { cfg, word } = node;
    if (cert.length < certLimit) cert.push(cfg);

    if (m1.isAccepting(cfg.s1) !== m2.isAccepting(cfg.s2)) {
      if (!best || lexCompare(word, best.word) < 0) best = { kind: "acceptance", word };
      continue;
    }

    // Children cannot improve on an already-found word of this length or shorter.
    if (best && word.length + 1 >= best.word.length) continue;

    for (let i = 0; i < m1.alphabet.length; i++) {
      const n1 = m1.step(cfg.s1, cfg.r1, i);
      const n2 = m2.step(cfg.s2, cfg.r2, i);
      const sym = m1.alphabet[i];
      if (n1.output !== n2.output) {
        const candidate = [...word, sym];
        if (!best || lexCompare(candidate, best.word) < 0) best = { kind: "output", word: candidate };
        continue;
      }
      const next: ProductConfig = { s1: n1.state, s2: n2.state, r1: n1.regs, r2: n2.regs };
      const k = key(next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ cfg: next, word: [...word, sym] });
      }
    }
  }

  if (best) {
    return { status: "distinguished", explored, kind: best.kind, word: best.word };
  }
  return {
    status: "equivalent",
    explored,
    certificate: {
      reachableConfigurations: explored,
      states1: m1.states.length,
      states2: m2.states.length,
      registerBits: 8,
      configurations: cert,
      truncated: explored > cert.length,
    },
  };
}
