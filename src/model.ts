import type { DagNode } from "./dag.js";
import type { Observation } from "./rank.js";

/**
 * Reference model: plain item-by-item weight accumulation.
 * Used in tests to cross-check the ranking index.
 */
export function modelPercentile(items: Iterable<Observation>, value: number): number | null {
  let less = 0;
  let equal = 0;
  let total = 0;
  let count = 0;
  for (const o of items) {
    count += 1;
    total += o.weight;
    if (o.value < value) {
      less += o.weight;
    } else if (o.value === value) {
      equal += o.weight;
    }
  }
  if (count === 0 || total === 0) {
    return null;
  }
  return (less + equal / 2) / total;
}

/**
 * Reference model: sort by value, then accumulate weights group by group.
 * Returns the mid-rank percentile score for every id.
 */
export function sortedModelScores(entries: Array<[string, Observation]>): Map<string, number> {
  const result = new Map<string, number>();
  if (entries.length === 0) {
    return result;
  }
  const sorted = [...entries].sort((a, b) => a[1].value - b[1].value);
  let total = 0;
  for (const [, o] of sorted) {
    total += o.weight;
  }
  if (total === 0) {
    return result;
  }
  let less = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let equal = 0;
    while (j < sorted.length && sorted[j][1].value === sorted[i][1].value) {
      equal += sorted[j][1].weight;
      j += 1;
    }
    const score = (less + equal / 2) / total;
    for (let k = i; k < j; k += 1) {
      result.set(sorted[k][0], score);
    }
    less += equal;
    i = j;
  }
  return result;
}

/**
 * Reference model: eager full-DAG evaluation. Evaluates every node,
 * including both branches of conditional nodes, and returns all weights.
 * Used in tests to cross-check the lazy DAG evaluator.
 */
export function eagerDagWeights(
  nodes: Record<string, DagNode>,
  sources: Readonly<Record<string, number>>,
): Map<string, number> {
  const weights = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (name: string): number => {
    const cached = weights.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodes[name];
    if (node === undefined) {
      throw new Error(`unknown node: ${name}`);
    }
    if (visiting.has(name)) {
      throw new Error(`cycle detected at node: ${name}`);
    }
    visiting.add(name);
    let value: number;
    switch (node.kind) {
      case "source": {
        const v = sources[name];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(`missing source value: ${name}`);
        }
        value = v;
        break;
      }
      case "const":
        value = node.value;
        break;
      case "add":
        value = node.deps.reduce((acc, dep) => acc + visit(dep), 0);
        break;
      case "mul":
        value = node.deps.reduce((acc, dep) => acc * visit(dep), 1);
        break;
      case "cond": {
        const picked = visit(node.pick) > 0 ? node.then : node.else;
        // Eager model evaluates both branches, then keeps the selected one.
        visit(node.then);
        visit(node.else);
        value = visit(picked);
        break;
      }
    }
    visiting.delete(name);
    weights.set(name, value);
    return value;
  };

  for (const name of Object.keys(nodes)) {
    visit(name);
  }
  return weights;
}
