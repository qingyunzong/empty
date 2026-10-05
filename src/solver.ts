import {
  edgeValue,
  overlaps,
  type AlignmentConstraint,
  type Edge,
  type Layout,
  type Placement,
  type Problem,
} from './model.js';

export interface Candidate extends Placement {
  dist: number;
}

interface PairAlignment {
  other: number; // rect index
  selfEdge: Edge;
  otherEdge: Edge;
}

export interface SolveOptions {
  /** Maximum number of search-tree nodes expanded. Defaults to 200_000. */
  maxNodes?: number;
}

export type SolveStatus = 'optimal' | 'budget_exhausted' | 'infeasible';

export interface SolveResult {
  status: SolveStatus;
  /** Best feasible layout found (null if none yet). */
  layout: Layout | null;
  /** Cost of `layout`; a certified upper bound on the optimum. */
  objective: number | null;
  /** Certified lower bound on the optimum (null when nothing is known, e.g. infeasible). */
  lowerBound: number | null;
  nodesExpanded: number;
}

/** All placements of one rect that satisfy the grid, its size range and its fixed alignments. */
export function generateCandidates(problem: Problem, rectIndex: number): Candidate[] {
  const rect = problem.rects[rectIndex]!;
  const old = problem.oldLayout[rect.id];
  if (!old) throw new Error(`old layout missing rect ${rect.id}`);
  const fixed = problem.alignments.filter(
    (c): c is Extract<AlignmentConstraint, { kind: 'fixed' }> =>
      c.kind === 'fixed' && c.a === rect.id,
  );
  const out: Candidate[] = [];
  for (let w = rect.minW; w <= rect.maxW; w++) {
    for (let h = rect.minH; h <= rect.maxH; h++) {
      for (let x = 0; x + w <= problem.grid; x++) {
        for (let y = 0; y + h <= problem.grid; y++) {
          const p: Placement = { x, y, w, h };
          if (fixed.some((c) => edgeValue(p, c.edgeA) !== c.value)) continue;
          out.push({ x, y, w, h, dist: Math.abs(x - old.x) + Math.abs(y - old.y) });
        }
      }
    }
  }
  out.sort((a, b) => a.dist - b.dist || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h);
  return out;
}

function buildPairAlignments(problem: Problem): PairAlignment[][] {
  const indexOf = new Map(problem.rects.map((r, i) => [r.id, i]));
  const per: PairAlignment[][] = problem.rects.map(() => []);
  for (const c of problem.alignments) {
    if (c.kind !== 'pair') continue;
    const ia = indexOf.get(c.a);
    const ib = indexOf.get(c.b);
    if (ia === undefined || ib === undefined) continue;
    per[ia]!.push({ other: ib, selfEdge: c.edgeA, otherEdge: c.edgeB });
    per[ib]!.push({ other: ia, selfEdge: c.edgeB, otherEdge: c.edgeA });
  }
  return per;
}

/** Check a candidate against already-assigned rects: non-overlap + pair alignments. */
function isConsistent(
  cand: Placement,
  rectIndex: number,
  assignment: (Placement | null)[],
  pairAlignments: PairAlignment[][],
): boolean {
  for (let i = 0; i < assignment.length; i++) {
    const other = assignment[i];
    if (other && overlaps(cand, other)) return false;
  }
  for (const pa of pairAlignments[rectIndex]!) {
    const other = assignment[pa.other];
    if (other && edgeValue(cand, pa.selfEdge) !== edgeValue(other, pa.otherEdge)) return false;
  }
  return true;
}

/** Min-heap of search nodes keyed by (lowerBound, insertion order). */
class NodeHeap {
  private lbs: number[] = [];
  private seqs: number[] = [];
  private nodes: SearchNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  peek(): SearchNode | undefined {
    return this.nodes[0];
  }

  peekLb(): number {
    return this.lbs.length ? this.lbs[0]! : Infinity;
  }

  push(lb: number, seq: number, node: SearchNode): void {
    this.lbs.push(lb);
    this.seqs.push(seq);
    this.nodes.push(node);
    let i = this.lbs.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else break;
    }
  }

  pop(): SearchNode | undefined {
    const top = this.nodes[0];
    const lastLb = this.lbs.pop()!;
    const lastSeq = this.seqs.pop()!;
    const lastNode = this.nodes.pop()!;
    if (this.nodes.length > 0) {
      this.lbs[0] = lastLb;
      this.seqs[0] = lastSeq;
      this.nodes[0] = lastNode;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.lbs.length && this.less(l, smallest)) smallest = l;
        if (r < this.lbs.length && this.less(r, smallest)) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  /** Keep only the `k` smallest entries (a sorted array is a valid heap).
   *  Returns the smallest dropped bound, or Infinity if nothing was dropped. */
  truncateToSmallest(k: number): number {
    if (this.nodes.length <= k) return Infinity;
    const idx = this.lbs.map((_, i) => i);
    idx.sort((a, b) => this.lbs[a]! - this.lbs[b]! || this.seqs[a]! - this.seqs[b]!);
    const droppedMin = this.lbs[idx[Math.min(k, idx.length - 1)]!]!;
    const keep = idx.slice(0, k);
    this.lbs = keep.map((i) => this.lbs[i]!);
    this.seqs = keep.map((i) => this.seqs[i]!);
    this.nodes = keep.map((i) => this.nodes[i]!);
    return droppedMin;
  }

  private less(a: number, b: number): boolean {
    return this.lbs[a]! < this.lbs[b]! || (this.lbs[a] === this.lbs[b] && this.seqs[a]! < this.seqs[b]!);
  }

  private swap(a: number, b: number): void {
    [this.lbs[a], this.lbs[b]] = [this.lbs[b]!, this.lbs[a]!];
    [this.seqs[a], this.seqs[b]] = [this.seqs[b]!, this.seqs[a]!];
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
  }
}

interface SearchNode {
  /** Parent pointer; the partial assignment is reconstructed by walking the chain. */
  parent: SearchNode | null;
  /** Rect assigned at this node (-1 for the root). */
  rectIndex: number;
  placement: Placement | null;
  depth: number;
  cost: number;
  /** Heap key: a valid lower bound (weak until `residuals` is computed). */
  lb: number;
  /** Per-depth-slot residual minima, computed when the exact bound is evaluated. */
  residuals: number[] | null;
}

/** Maximum open nodes kept; the heap is truncated to half when exceeded. */
const HEAP_CAP = 300_000;

/**
 * Best-first branch & bound with lazy bound evaluation.
 *
 * Rects are assigned in a fixed most-constrained-first order. A node's exact lower
 * bound is its partial cost plus, for every unassigned rect, the cheapest candidate
 * consistent with the assigned rects (alignments between two unassigned rects are
 * relaxed). Children are pushed with an O(1) incremental weak bound derived from the
 * parent's residuals; the exact bound is evaluated once the node is popped. Weak
 * bounds are valid, so the heap minimum is always a certified global lower bound,
 * which is reported alongside the incumbent when the node budget runs out.
 */
export function solve(problem: Problem, options: SolveOptions = {}): SolveResult {
  const maxNodes = options.maxNodes ?? 200_000;
  const n = problem.rects.length;
  const pairAlignments = buildPairAlignments(problem);
  const candidates = problem.rects.map((_, i) => generateCandidates(problem, i));
  if (candidates.some((c) => c.length === 0)) {
    return { status: 'infeasible', layout: null, objective: null, lowerBound: null, nodesExpanded: 0 };
  }
  const order = problem.rects
    .map((_, i) => i)
    .sort((a, b) => candidates[a]!.length - candidates[b]!.length || a - b);

  const consistent = (cand: Placement, rectIndex: number, assignment: (Placement | null)[]) =>
    isConsistent(cand, rectIndex, assignment, pairAlignments);

  const materialize = (node: SearchNode): (Placement | null)[] => {
    const assignment = new Array<Placement | null>(n).fill(null);
    for (let cur: SearchNode | null = node; cur && cur.rectIndex >= 0; cur = cur.parent) {
      assignment[cur.rectIndex] = cur.placement;
    }
    return assignment;
  };

  /** Cheapest candidate of `rectIndex` consistent with the current partial assignment. */
  const minResidual = (rectIndex: number, assignment: (Placement | null)[]): number => {
    for (const cand of candidates[rectIndex]!) {
      if (consistent(cand, rectIndex, assignment)) return cand.dist;
    }
    return Infinity;
  };

  /** Exact bound + per-slot residuals for a node, from its materialized assignment. */
  const evaluateExact = (node: SearchNode): number => {
    const assignment = materialize(node);
    const residuals = new Array<number>(n).fill(0);
    let lb = node.cost;
    for (let d = node.depth; d < n; d++) {
      const r = minResidual(order[d]!, assignment);
      residuals[d] = r;
      if (!Number.isFinite(r)) {
        lb = Infinity;
        break;
      }
      lb += r;
    }
    node.residuals = residuals;
    node.lb = lb;
    return lb;
  };

  const heap = new NodeHeap();
  let seq = 0;
  const root: SearchNode = {
    parent: null,
    rectIndex: -1,
    placement: null,
    depth: 0,
    cost: 0,
    lb: 0,
    residuals: null,
  };
  const rootLb = evaluateExact(root);
  if (!Number.isFinite(rootLb)) {
    return { status: 'infeasible', layout: null, objective: null, lowerBound: null, nodesExpanded: 0 };
  }
  heap.push(rootLb, seq++, root);

  let incumbent: number = Infinity;
  let incumbentLayout: Layout | null = null;
  let nodesExpanded = 0;
  let exhausted = false;
  let droppedLb = Infinity;

  // Greedy dive along the rect order for an early incumbent (upper bound).
  {
    const assignment = new Array<Placement | null>(n).fill(null);
    let cost = 0;
    let complete = true;
    for (let d = 0; d < n && complete; d++) {
      const r = order[d]!;
      let placed = false;
      for (const cand of candidates[r]!) {
        if (consistent(cand, r, assignment)) {
          assignment[r] = { x: cand.x, y: cand.y, w: cand.w, h: cand.h };
          cost += cand.dist;
          placed = true;
          break;
        }
      }
      if (!placed) complete = false;
    }
    if (complete) {
      incumbent = cost;
      incumbentLayout = {};
      for (let i = 0; i < n; i++) incumbentLayout[problem.rects[i]!.id] = assignment[i]!;
    }
  }

  const toLayout = (node: SearchNode): Layout => {
    const assignment = materialize(node);
    const layout: Layout = {};
    for (let i = 0; i < n; i++) layout[problem.rects[i]!.id] = assignment[i]!;
    return layout;
  };

  while (heap.size > 0) {
    if (heap.peekLb() >= incumbent) break; // every open node is bounded at/above the incumbent: optimal
    if (nodesExpanded >= maxNodes) {
      exhausted = true;
      break;
    }
    const node = heap.pop()!;

    if (node.depth === n) {
      if (node.cost < incumbent) {
        incumbent = node.cost;
        incumbentLayout = toLayout(node);
      }
      continue;
    }

    if (node.residuals === null) {
      if (evaluateExact(node) >= incumbent) continue; // exact bound prunes the node
    }
    nodesExpanded++;

    const assignment = materialize(node);
    const rectIndex = order[node.depth]!;
    const slotResidual = node.residuals![node.depth]!;
    for (const cand of candidates[rectIndex]!) {
      if (node.cost + cand.dist >= incumbent) break; // candidates sorted by dist
      if (!consistent(cand, rectIndex, assignment)) continue;
      // weak bound: sibling residuals only tighten as more rects get assigned
      const weakLb = node.lb - slotResidual + cand.dist;
      if (weakLb >= incumbent) continue;
      const child: SearchNode = {
        parent: node,
        rectIndex,
        placement: { x: cand.x, y: cand.y, w: cand.w, h: cand.h },
        depth: node.depth + 1,
        cost: node.cost + cand.dist,
        lb: weakLb,
        residuals: null,
      };
      heap.push(weakLb, seq++, child);
    }
    if (heap.size > HEAP_CAP) {
      droppedLb = Math.min(droppedLb, heap.truncateToSmallest(HEAP_CAP >> 1));
    }
  }

  const openLb = heap.size > 0 ? heap.peekLb() : Infinity;
  const certifiedLb = Math.min(openLb, droppedLb, incumbent);

  if (incumbentLayout === null) {
    if (!exhausted && heap.size === 0 && droppedLb === Infinity) {
      return { status: 'infeasible', layout: null, objective: null, lowerBound: null, nodesExpanded };
    }
    return {
      status: 'budget_exhausted',
      layout: null,
      objective: null,
      lowerBound: Number.isFinite(certifiedLb) ? certifiedLb : 0,
      nodesExpanded,
    };
  }

  const optimal = !exhausted && certifiedLb >= incumbent;
  return {
    status: optimal ? 'optimal' : 'budget_exhausted',
    layout: incumbentLayout,
    objective: incumbent,
    lowerBound: certifiedLb,
    nodesExpanded,
  };
}
