import type { Instance } from "../src/solver.js";

export interface BruteResult {
  bins: number;
  /** Canonical load sequence: bin loads ordered by each bin's smallest item id. */
  loads: number[];
}

/**
 * Reference solver: enumerates every set partition of the items (restricted
 * growth strings), filters by the group/forbidden/capacity constraints, and
 * returns the optimum of (bin count, canonical load sequence).
 * Only suitable for small instances.
 */
export function bruteForce(inst: Instance): BruteResult | null {
  const n = inst.items.length;
  const ids = inst.items.map((it) => it.id);
  const sizes = inst.items.map((it) => it.size);
  const groupOf = inst.items.map((it) => (it.group === undefined ? null : String(it.group)));
  const forbidden = (inst.forbidden ?? []).map(([a, b]) => [ids.indexOf(a), ids.indexOf(b)]);

  let best: { count: number; loads: number[] } | null = null;
  const assign = new Array<number>(n).fill(0);
  const blockSum: number[] = [];

  function consider(): void {
    const count = blockSum.length;
    const cur = best;
    if (cur !== null && count > cur.count) return;
    // Group constraint: same group -> same block.
    const groupBlock = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const g = groupOf[i]!;
      if (g === null) continue;
      const prev = groupBlock.get(g);
      if (prev === undefined) groupBlock.set(g, assign[i]!);
      else if (prev !== assign[i]) return;
    }
    // Forbidden pairs.
    for (const [a, b] of forbidden) {
      if (assign[a!] === assign[b!]) return;
    }
    // Canonical loads: blocks ordered by smallest member item id.
    const keyed: [number, number][] = [];
    for (let b = 0; b < count; b++) {
      let minId = Infinity;
      for (let i = 0; i < n; i++) {
        if (assign[i] === b && ids[i]! < minId) minId = ids[i]!;
      }
      keyed.push([minId, blockSum[b]!]);
    }
    keyed.sort((x, y) => x[0] - y[0]);
    const loads = keyed.map((p) => p[1]);
    if (cur === null || count < cur.count || (count === cur.count && lexLess(loads, cur.loads))) {
      best = { count, loads };
    }
  }

  function lexLess(a: number[], b: number[]): boolean {
    for (let i = 0; i < a.length && i < b.length; i++) {
      if (a[i]! !== b[i]!) return a[i]! < b[i]!;
    }
    return a.length < b.length;
  }

  function dfs(i: number): void {
    if (i === n) {
      consider();
      return;
    }
    const cur = best;
    for (let b = 0; b <= blockSum.length; b++) {
      const isNew = b === blockSum.length;
      if (isNew) {
        if (cur !== null && blockSum.length + 1 > cur.count) continue;
        blockSum.push(sizes[i]!);
      } else {
        if (blockSum[b]! + sizes[i]! > inst.capacity) continue;
        blockSum[b]! += sizes[i]!;
      }
      assign[i] = b;
      dfs(i + 1);
      if (isNew) blockSum.pop();
      else blockSum[b]! -= sizes[i]!;
    }
  }

  dfs(0);
  const result = best as { count: number; loads: number[] } | null;
  return result === null ? null : { bins: result.count, loads: result.loads };
}
