/**
 * Problem model for tree-structured integer budget allocation.
 *
 * Semantics fixed by this module:
 *  - Allocations x_i are integers, one per leaf, in leaf document order (DFS).
 *  - Leaf payoff is an arbitrary discrete table (NOT required to be concave).
 *  - A fixed startup fee is deducted from the leaf payoff when x_i > 0:
 *      gain_i(0) = payoff_i[0]
 *      gain_i(x) = payoff_i[x] - startupFee_i   (x > 0)
 *  - Every node carries an aggregate bound [min, max] on the sum of the
 *    allocations in its subtree (a leaf's aggregate is its own allocation).
 *  - The root aggregate additionally may not exceed `budget` (<= 80).
 *  - Cross constraints couple leaves across subtrees: |x_a - x_b| <= maxDiff.
 */

export const MAX_BUDGET = 80;
export const MAX_CROSS_CONSTRAINTS = 10;

export interface LeafSpec {
  /** payoff[x] for x = 0..payoff.length-1; arbitrary finite numbers. */
  payoff: number[];
  /** Fixed fee deducted from the payoff when the leaf is funded (x > 0). */
  startupFee?: number;
}

export interface NodeSpec {
  id: string;
  /** Aggregate lower bound for this node's subtree (default 0). */
  min?: number;
  /** Aggregate upper bound for this node's subtree (default: budget). */
  max?: number;
  leaf?: LeafSpec;
  children?: NodeSpec[];
}

export interface CrossConstraint {
  /** Leaf indices (document order); must belong to different leaves. */
  a: number;
  b: number;
  /** |x_a - x_b| <= maxDiff */
  maxDiff: number;
}

export interface Problem {
  /** Total budget; integer in [0, 80]. */
  budget: number;
  root: NodeSpec;
  /** Up to 10 cross-subtree difference constraints. */
  constraints?: CrossConstraint[];
}

export interface LeafInfo {
  index: number;
  nodeId: string;
  min: number;
  max: number;
  /** Effective payoff by allocation, startup fee already deducted for x > 0. */
  gain: number[];
  startupFee: number;
}

export interface NormalizedNode {
  id: string;
  min: number;
  max: number;
  children: NormalizedNode[];
  leafIndex: number | null;
}

export interface NormalizedProblem {
  budget: number;
  root: NormalizedNode;
  /** All tree nodes in DFS pre-order (internal nodes and leaves). */
  nodes: NormalizedNode[];
  /** Leaves in document order; leaf index i corresponds to vector[i]. */
  leaves: LeafInfo[];
  constraints: CrossConstraint[];
}

function fail(message: string): never {
  throw new Error(message);
}

export function normalize(problem: Problem): NormalizedProblem {
  if (!problem || typeof problem !== 'object') fail('problem must be an object');
  const { budget, root } = problem;
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
    fail(`budget must be an integer in [0, ${MAX_BUDGET}], got ${budget}`);
  }
  if (!root || typeof root !== 'object') fail('root node is required');

  const leaves: LeafInfo[] = [];
  const nodes: NormalizedNode[] = [];
  const ids = new Set<string>();

  const build = (spec: NodeSpec): NormalizedNode => {
    if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
      fail('every node needs a non-empty string id');
    }
    if (ids.has(spec.id)) fail(`duplicate node id: ${spec.id}`);
    ids.add(spec.id);

    const min = spec.min ?? 0;
    const max = spec.max ?? budget;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max) {
      fail(`node ${spec.id}: invalid aggregate bounds [${min}, ${max}]`);
    }

    const hasLeaf = spec.leaf !== undefined && spec.leaf !== null;
    const hasChildren = Array.isArray(spec.children) && spec.children.length > 0;
    if (hasLeaf === hasChildren) {
      fail(`node ${spec.id}: specify exactly one of "leaf" or a non-empty "children"`);
    }

    if (hasLeaf) {
      const table = spec.leaf!.payoff;
      if (!Array.isArray(table) || table.length === 0 || !table.every(Number.isFinite)) {
        fail(`node ${spec.id}: payoff must be a non-empty array of finite numbers`);
      }
      const fee = spec.leaf!.startupFee ?? 0;
      if (!Number.isFinite(fee)) fail(`node ${spec.id}: startupFee must be finite`);
      const cap = table.length - 1;
      const hi = Math.min(max, cap);
      const gain = table.map((value, x) => (x > 0 ? value - fee : value));
      const leafIndex = leaves.length;
      leaves.push({ index: leafIndex, nodeId: spec.id, min, max: hi, gain, startupFee: fee });
      const node: NormalizedNode = { id: spec.id, min, max: hi, children: [], leafIndex };
      nodes.push(node);
      return node;
    }

    const children = spec.children!.map(build);
    const node: NormalizedNode = { id: spec.id, min, max: Math.min(max, budget), children, leafIndex: null };
    nodes.push(node);
    return node;
  };

  const rootNode = build(root);
  if (leaves.length === 0) fail('tree must contain at least one leaf');

  const constraints = problem.constraints ?? [];
  if (constraints.length > MAX_CROSS_CONSTRAINTS) {
    fail(`at most ${MAX_CROSS_CONSTRAINTS} cross constraints are supported, got ${constraints.length}`);
  }
  for (const c of constraints) {
    const okIndex = (i: number) => Number.isInteger(i) && i >= 0 && i < leaves.length;
    if (!okIndex(c.a) || !okIndex(c.b) || c.a === c.b) {
      fail(`invalid cross constraint (${c.a}, ${c.b}) for ${leaves.length} leaves`);
    }
    if (!Number.isInteger(c.maxDiff) || c.maxDiff < 0) {
      fail('cross constraint maxDiff must be a non-negative integer');
    }
  }

  return { budget, root: rootNode, nodes, leaves, constraints };
}

/** Sum of allocations in every subtree, keyed by node id. */
export function computeAggregates(root: NormalizedNode, vector: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (node: NormalizedNode): number => {
    const sum =
      node.leafIndex !== null
        ? vector[node.leafIndex]
        : node.children.reduce((acc, child) => acc + walk(child), 0);
    out[node.id] = sum;
    return sum;
  };
  walk(root);
  return out;
}

export interface Evaluation {
  feasible: boolean;
  violations: string[];
  payoff: number;
  aggregates: Record<string, number>;
}

/** Full feasibility check + payoff of a concrete leaf allocation vector. */
export function evaluateVector(norm: NormalizedProblem, vector: number[]): Evaluation {
  const violations: string[] = [];
  if (vector.length !== norm.leaves.length) {
    violations.push(`expected ${norm.leaves.length} leaf allocations, got ${vector.length}`);
  }
  const vec = norm.leaves.map((_, i) => vector[i] ?? 0);

  let payoff = 0;
  let total = 0;
  for (let i = 0; i < norm.leaves.length; i++) {
    const x = vec[i];
    const leaf = norm.leaves[i];
    if (!Number.isInteger(x) || x < 0) {
      violations.push(`leaf ${leaf.nodeId}: allocation ${x} is not a non-negative integer`);
      continue;
    }
    if (x >= leaf.gain.length) {
      violations.push(`leaf ${leaf.nodeId}: allocation ${x} exceeds payoff table (cap ${leaf.gain.length - 1})`);
      continue;
    }
    payoff += leaf.gain[x];
    total += x;
  }
  if (total > norm.budget) {
    violations.push(`total allocation ${total} exceeds budget ${norm.budget}`);
  }

  const aggregates = computeAggregates(norm.root, vec);
  for (const node of norm.nodes) {
    const sum = aggregates[node.id];
    if (sum < node.min || sum > node.max) {
      violations.push(`node ${node.id}: aggregate ${sum} outside [${node.min}, ${node.max}]`);
    }
  }

  for (const c of norm.constraints) {
    const diff = Math.abs(vec[c.a] - vec[c.b]);
    if (diff > c.maxDiff) {
      violations.push(
        `cross constraint (${norm.leaves[c.a].nodeId}, ${norm.leaves[c.b].nodeId}): |${vec[c.a]} - ${vec[c.b]}| = ${diff} > ${c.maxDiff}`,
      );
    }
  }

  return { feasible: violations.length === 0, violations, payoff, aggregates };
}
