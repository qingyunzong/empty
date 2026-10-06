/**
 * Global solver for problems WITH cross-subtree difference constraints
 * (|x_a - x_b| <= maxDiff, at most 10) and fixed startup fees.
 *
 * Cross constraints couple leaves in different subtrees, so subtrees cannot
 * be optimized independently and spliced together. This solver therefore
 * runs a whole-tree depth-first branch-and-bound over leaf allocations
 * (ascending values, leaves in document order => lexicographic enumeration):
 *
 *  - Bound: an exact tree DP of the residual relaxation (assigned leaves
 *    fixed, domains of unassigned leaves clamped by constraints to assigned
 *    partners, cross constraints between two unassigned leaves ignored).
 *    The relaxation optimum is a valid upper bound on any completion.
 *  - Tie-break: strict improvement only, so the lexicographically smallest
 *    optimal vector is returned.
 *  - Work budget: run(maxSteps) processes at most maxSteps candidates and
 *    can be called again to continue ("可续算"). A run that has not closed
 *    the search tree reports status "unclosed" and is NEVER labeled optimal,
 *    even when it already holds a feasible incumbent.
 */

import {
  CrossConstraint,
  NormalizedNode,
  NormalizedProblem,
  Problem,
  computeAggregates,
  normalize,
} from './model';

export interface ConstraintCertificate {
  a: number;
  b: number;
  aId: string;
  bId: string;
  xA: number;
  xB: number;
  diff: number;
  maxDiff: number;
  satisfied: boolean;
}

export interface SearchStats {
  /** Candidate allocations visited (search nodes). */
  nodesExplored: number;
  /** Candidates cut off by the relaxation bound. */
  pruned: number;
  /** Total work-budget steps consumed across all run() calls. */
  stepsUsed: number;
}

export interface ConstrainedResult {
  /** "optimal" only when the search tree is closed and a solution exists. */
  status: 'optimal' | 'unclosed' | 'infeasible';
  closed: boolean;
  /** True iff status === "optimal"; an unclosed incumbent is not optimal. */
  optimal: boolean;
  payoff: number | null;
  vector: number[] | null;
  aggregates: Record<string, number> | null;
  /** Cross-edge certificate for the reported vector, plus search stats. */
  certificate: { constraints: ConstraintCertificate[]; stats: SearchStats } | null;
  stats: SearchStats;
}

interface Frame {
  leaf: number;
  nextX: number;
  maxX: number;
}

export class ConstrainedSolver {
  private readonly norm: NormalizedProblem;
  private readonly incident: { partner: number; maxDiff: number }[][];
  private readonly stack: Frame[] = [];
  private readonly assigned: number[] = [];
  private bestVector: number[] | null = null;
  private bestPayoff = -Infinity;
  private closedFlag = false;
  private readonly stats: SearchStats = { nodesExplored: 0, pruned: 0, stepsUsed: 0 };

  constructor(problem: Problem) {
    this.norm = normalize(problem);
    this.incident = this.norm.leaves.map(() => []);
    for (const c of this.norm.constraints) {
      this.incident[c.a].push({ partner: c.b, maxDiff: c.maxDiff });
      this.incident[c.b].push({ partner: c.a, maxDiff: c.maxDiff });
    }
    this.stack.push(this.makeFrame(0));
  }

  get normalized(): NormalizedProblem {
    return this.norm;
  }

  /** Domain of a leaf clamped by constraints whose partner is assigned. */
  private leafDomain(leafIndex: number): { lo: number; hi: number } {
    const leaf = this.norm.leaves[leafIndex];
    let lo = leaf.min;
    let hi = Math.min(leaf.max, leaf.gain.length - 1);
    for (const inc of this.incident[leafIndex]) {
      if (inc.partner < this.assigned.length) {
        const xp = this.assigned[inc.partner];
        lo = Math.max(lo, xp - inc.maxDiff);
        hi = Math.min(hi, xp + inc.maxDiff);
      }
    }
    return { lo, hi };
  }

  private makeFrame(leafIndex: number): Frame {
    const { lo, hi } = this.leafDomain(leafIndex);
    let spent = 0;
    for (let i = 0; i < this.assigned.length; i++) spent += this.assigned[i];
    const maxX = Math.min(hi, this.norm.budget - spent);
    return { leaf: leafIndex, nextX: lo, maxX };
  }

  /** Check constraints whose endpoints are both assigned (<= depth). */
  private violatesAssigned(depth: number): boolean {
    for (const c of this.norm.constraints) {
      if (c.a <= depth && c.b <= depth) {
        if (Math.abs(this.assigned[c.a] - this.assigned[c.b]) > c.maxDiff) return true;
      }
    }
    return false;
  }

  /**
   * Upper bound on the total gain of any completion of the current partial
   * assignment: exact tree DP of the residual relaxation (cross constraints
   * between unassigned leaves ignored). -Infinity when infeasible.
   */
  private residualBound(): number {
    const budget = this.norm.budget;

    const solve = (node: NormalizedNode): number[] => {
      if (node.leafIndex !== null) {
        const dp = new Array<number>(budget + 1).fill(-Infinity);
        const i = node.leafIndex;
        const leaf = this.norm.leaves[i];
        if (i < this.assigned.length) {
          const x = this.assigned[i];
          if (x <= budget) dp[x] = leaf.gain[x];
        } else {
          const { lo, hi } = this.leafDomain(i);
          const top = Math.min(hi, budget);
          for (let x = lo; x <= top; x++) dp[x] = leaf.gain[x];
        }
        return dp;
      }

      let acc = new Array<number>(budget + 1).fill(-Infinity);
      acc[0] = 0;
      for (const child of node.children) {
        const childDp = solve(child);
        const next = new Array<number>(budget + 1).fill(-Infinity);
        for (let s1 = 0; s1 <= budget; s1++) {
          if (acc[s1] === -Infinity) continue;
          for (let s2 = 0; s1 + s2 <= budget; s2++) {
            if (childDp[s2] === -Infinity) continue;
            const value = acc[s1] + childDp[s2];
            if (value > next[s1 + s2]) next[s1 + s2] = value;
          }
        }
        acc = next;
      }
      for (let s = 0; s <= budget; s++) {
        if (s < node.min || s > node.max) acc[s] = -Infinity;
      }
      return acc;
    };

    const rootDp = solve(this.norm.root);
    let best = -Infinity;
    for (let s = 0; s <= budget; s++) if (rootDp[s] > best) best = rootDp[s];
    return best;
  }

  /**
   * Advance the search by at most maxSteps candidate allocations and return
   * the current result. Call again with a fresh budget to continue; the
   * search state persists between calls.
   */
  run(maxSteps = Infinity): ConstrainedResult {
    if (!this.closedFlag) {
      const lastLeaf = this.norm.leaves.length - 1;
      let steps = 0;
      while (this.stack.length > 0) {
        if (steps >= maxSteps) break;
        const frame = this.stack[this.stack.length - 1];
        if (frame.nextX > frame.maxX) {
          this.stack.pop();
          this.assigned.length = frame.leaf;
          continue;
        }
        const x = frame.nextX++;
        steps++;
        this.stats.stepsUsed++;
        this.stats.nodesExplored++;
        this.assigned[frame.leaf] = x;
        this.assigned.length = frame.leaf + 1;

        if (this.violatesAssigned(frame.leaf)) continue;

        if (frame.leaf === lastLeaf) {
          let total = 0;
          for (let i = 0; i < this.assigned.length; i++) {
            total += this.norm.leaves[i].gain[this.assigned[i]];
          }
          if (total > this.bestPayoff) {
            this.bestPayoff = total;
            this.bestVector = this.assigned.slice();
          }
        } else {
          if (this.residualBound() <= this.bestPayoff) {
            this.stats.pruned++;
            continue;
          }
          this.stack.push(this.makeFrame(frame.leaf + 1));
        }
      }
      if (this.stack.length === 0) this.closedFlag = true;
    }
    return this.result();
  }

  private result(): ConstrainedResult {
    const closed = this.closedFlag;
    const has = this.bestVector !== null;
    const status: ConstrainedResult['status'] = !closed ? 'unclosed' : has ? 'optimal' : 'infeasible';

    let aggregates: Record<string, number> | null = null;
    let certificate: ConstrainedResult['certificate'] = null;
    if (has) {
      const vector = this.bestVector!;
      aggregates = computeAggregates(this.norm.root, vector);
      certificate = {
        constraints: this.norm.constraints.map((c: CrossConstraint) => {
          const xA = vector[c.a];
          const xB = vector[c.b];
          const diff = Math.abs(xA - xB);
          return {
            a: c.a,
            b: c.b,
            aId: this.norm.leaves[c.a].nodeId,
            bId: this.norm.leaves[c.b].nodeId,
            xA,
            xB,
            diff,
            maxDiff: c.maxDiff,
            satisfied: diff <= c.maxDiff,
          };
        }),
        stats: { ...this.stats },
      };
    }

    return {
      status,
      closed,
      optimal: closed && has,
      payoff: has ? this.bestPayoff : null,
      vector: has ? this.bestVector!.slice() : null,
      aggregates,
      certificate,
      stats: { ...this.stats },
    };
  }
}
