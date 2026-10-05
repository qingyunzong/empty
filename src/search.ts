import type { Segment } from "./pattern.js";
import { SymbolTable, compareSymPaths, type Sym } from "./alphabet.js";

export const DEFAULT_BUDGET = 200_000;

export type SearchResult =
  | { status: "common"; witness: string[]; expansions: number }
  | { status: "disjoint"; expansions: number }
  | { status: "unknown"; expansions: number };

interface State {
  i: number;
  j: number;
  masks: number[];
}

interface QueueNode {
  state: State;
  path: Sym[];
}

/** NFA-subset tracker for one exclude pattern. */
class ExcludeAutomaton {
  private readonly segments: Segment[];
  private readonly endBit: number;

  constructor(segments: Segment[]) {
    this.segments = segments;
    this.endBit = 1 << segments.length;
  }

  /** Add positions reachable by matching a `**` against zero segments. */
  closure(mask: number): number {
    for (let p = 0; p < this.segments.length; p++) {
      if ((mask & (1 << p)) !== 0 && this.segments[p]!.kind === "dstar") {
        mask |= 1 << (p + 1);
      }
    }
    return mask;
  }

  start(): number {
    return this.closure(1);
  }

  advance(mask: number, sym: Sym): number {
    let next = 0;
    for (let p = 0; p < this.segments.length; p++) {
      if ((mask & (1 << p)) === 0) continue;
      const seg = this.segments[p]!;
      const matches =
        seg.kind === "star" ||
        seg.kind === "dstar" ||
        (sym.kind === "lit" && seg.value === sym.value);
      if (!matches) continue;
      next |= 1 << (p + 1);
      if (seg.kind === "dstar") next |= 1 << p;
    }
    return this.closure(next);
  }

  matched(mask: number): boolean {
    return (mask & this.endBit) !== 0;
  }
}

/** Min-heap ordered by (segment count, byte order of concretized path). */
class Frontier {
  private readonly nodes: QueueNode[] = [];

  constructor(private readonly table: SymbolTable) {}

  get size(): number {
    return this.nodes.length;
  }

  private less(a: QueueNode, b: QueueNode): boolean {
    if (a.path.length !== b.path.length) return a.path.length < b.path.length;
    return compareSymPaths(this.table, a.path, b.path) < 0;
  }

  push(node: QueueNode): void {
    const nodes = this.nodes;
    nodes.push(node);
    let child = nodes.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.less(nodes[child]!, nodes[parent]!)) break;
      [nodes[child], nodes[parent]] = [nodes[parent]!, nodes[child]!];
      child = parent;
    }
  }

  pop(): QueueNode | undefined {
    const nodes = this.nodes;
    const top = nodes[0];
    const last = nodes.pop();
    if (nodes.length > 0 && last !== undefined) {
      nodes[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < nodes.length && this.less(nodes[left]!, nodes[smallest]!)) smallest = left;
        if (right < nodes.length && this.less(nodes[right]!, nodes[smallest]!)) smallest = right;
        if (smallest === parent) break;
        [nodes[parent], nodes[smallest]] = [nodes[smallest]!, nodes[parent]!];
        parent = smallest;
      }
    }
    return top;
  }
}

/**
 * Decide whether the languages of allow patterns A and B intersect while
 * avoiding every exclude pattern. Returns the witness with the fewest
 * segments, breaking ties by byte order of the joined path. If the
 * expansion budget is exhausted the result is "unknown" rather than
 * "disjoint".
 */
export function searchIntersection(
  allowA: Segment[],
  allowB: Segment[],
  excludes: Segment[][],
  budget: number = DEFAULT_BUDGET,
): SearchResult {
  const table = new SymbolTable(
    [allowA, allowB, ...excludes].flatMap((pattern) =>
      pattern.flatMap((seg) => (seg.kind === "lit" ? [seg.value] : [])),
    ),
  );
  const excludeAutomata = excludes.map((pattern) => new ExcludeAutomaton(pattern));

  const frontier = new Frontier(table);
  frontier.push({
    state: { i: 0, j: 0, masks: excludeAutomata.map((aut) => aut.start()) },
    path: [],
  });

  const settled = new Set<string>();
  let expansions = 0;

  for (;;) {
    const node = frontier.pop();
    if (node === undefined) return { status: "disjoint", expansions };
    const { state, path } = node;
    const key = `${state.i},${state.j}|${state.masks.join(",")}`;
    if (settled.has(key)) continue;
    settled.add(key);
    expansions++;
    if (expansions > budget) return { status: "unknown", expansions };

    if (
      state.i === allowA.length &&
      state.j === allowB.length &&
      state.masks.every((mask, k) => !excludeAutomata[k]!.matched(mask))
    ) {
      return {
        status: "common",
        witness: path.map((sym) => table.concretize(sym)),
        expansions,
      };
    }

    const segA = state.i < allowA.length ? allowA[state.i]! : undefined;
    const segB = state.j < allowB.length ? allowB[state.j]! : undefined;

    const pushSkip = (ni: number, nj: number): void => {
      frontier.push({ state: { i: ni, j: nj, masks: state.masks }, path });
    };
    const pushConsume = (ni: number, nj: number, syms: Sym[]): void => {
      for (const sym of syms) {
        const masks = state.masks.map((mask, k) => excludeAutomata[k]!.advance(mask, sym));
        frontier.push({ state: { i: ni, j: nj, masks }, path: [...path, sym] });
      }
    };

    // A `**` segment may match zero segments (skip) on either side.
    if (segA?.kind === "dstar") pushSkip(state.i + 1, state.j);
    if (segB?.kind === "dstar") pushSkip(state.i, state.j + 1);

    if (segA !== undefined && segB !== undefined) {
      const ni = segA.kind === "dstar" ? state.i : state.i + 1;
      const nj = segB.kind === "dstar" ? state.j : state.j + 1;
      // When both sides are double-stars the consume transition is a
      // self-loop (ni, nj) === (i, j): it only lengthens the path, but
      // exclude patterns can force exactly that, so it must be kept.
      let syms: Sym[];
      if (segA.kind === "lit") {
        syms =
          segB.kind === "lit" && segB.value !== segA.value
            ? []
            : [{ kind: "lit", value: segA.value }];
      } else if (segB.kind === "lit") {
        syms = [{ kind: "lit", value: segB.value }];
      } else {
        syms = table.ordered;
      }
      if (syms.length > 0) pushConsume(ni, nj, syms);
    }
  }
}
