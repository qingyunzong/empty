/**
 * mini-csp-solver: finite-domain CSP solver for up to 16 variables.
 *
 * - Domains are bitmasks (value v <-> bit 1<<v), so each domain holds up to 31 values.
 * - Constraints: allDifferent(scope) and table(scope, allowedTuples) with GAC.
 * - Propagation is a fixpoint loop; every domain narrowing is recorded on a trail
 *   so that undoing a branch restores ALL domains exactly.
 * - Search is depth-first with a node budget. Outcomes:
 *     "sat"     -> a solution (or all solutions, in count mode)
 *     "unsat"   -> the search tree was fully explored, no solution (complete tree)
 *     "unknown" -> the node budget ran out; the frontier of open nodes is reported
 */

export const MAX_VARS = 16;
export const MAX_DOMAIN_SIZE = 31;

export interface AllDifferentConstraint {
  kind: "allDifferent";
  scope: number[];
}

export interface TableConstraint {
  kind: "table";
  scope: number[];
  /** Allowed tuples; each tuple has scope.length values. */
  tuples: number[][];
}

export type Constraint = AllDifferentConstraint | TableConstraint;

export function allDifferent(...vars: number[]): AllDifferentConstraint {
  return { kind: "allDifferent", scope: vars.slice() };
}

export function table(scope: number[], tuples: number[][]): TableConstraint {
  return { kind: "table", scope: scope.slice(), tuples: tuples.map((t) => t.slice()) };
}

export type SolveStatus = "sat" | "unsat" | "unknown";

export interface SolveResult {
  status: SolveStatus;
  /** First solution found (mode "first"), if any. */
  solution: number[] | null;
  /** Number of solutions found (mode "all" counts exhaustively within budget). */
  solutionCount: number;
  /** Search nodes explored (each branching point counts as one node). */
  nodes: number;
  /**
   * Number of open frontier nodes when the budget ran out (status "unknown").
   * Zero for "sat"/"unsat" in mode "all"; for mode "first" a "sat" result may
   * leave an unexplored frontier, reported here.
   */
  frontier: number;
}

interface TrailEntry {
  variable: number;
  removedMask: number;
}

export class Solver {
  private readonly numVars: number;
  private readonly domains: number[];
  private readonly constraints: Constraint[] = [];
  private readonly trail: TrailEntry[] = [];
  /** trail.length snapshots, one per active search level. */
  private readonly marks: number[] = [];

  constructor(domainSizes: number[]) {
    if (domainSizes.length === 0) throw new Error("need at least one variable");
    if (domainSizes.length > MAX_VARS) {
      throw new Error(`at most ${MAX_VARS} variables supported, got ${domainSizes.length}`);
    }
    for (const size of domainSizes) {
      if (!Number.isInteger(size) || size < 1 || size > MAX_DOMAIN_SIZE) {
        throw new Error(`domain size must be an integer in 1..${MAX_DOMAIN_SIZE}, got ${size}`);
      }
    }
    this.numVars = domainSizes.length;
    this.domains = domainSizes.map((size) => (1 << size) - 1);
  }

  addConstraint(constraint: Constraint): void {
    for (const v of constraint.scope) {
      if (!Number.isInteger(v) || v < 0 || v >= this.numVars) {
        throw new Error(`constraint references unknown variable ${v}`);
      }
    }
    if (constraint.kind === "table") {
      const arity = constraint.scope.length;
      for (const tuple of constraint.tuples) {
        if (tuple.length !== arity) {
          throw new Error(`table tuple arity ${tuple.length} != scope arity ${arity}`);
        }
      }
    }
    this.constraints.push(constraint);
  }

  /** Current domain of variable `v` as a sorted list of values (copy). */
  domainOf(v: number): number[] {
    const out: number[] = [];
    let mask = this.domains[v]!;
    while (mask !== 0) {
      const bit = mask & -mask;
      out.push(31 - Math.clz32(bit));
      mask ^= bit;
    }
    return out;
  }

  /** Snapshot of all domains (values, not masks). */
  snapshotDomains(): number[][] {
    return this.domains.map((_, v) => this.domainOf(v));
  }

  // ---- propagation -------------------------------------------------------

  private removeFromDomain(v: number, mask: number): boolean {
    const current = this.domains[v]!;
    const removed = current & mask;
    if (removed === 0) return true;
    const next = current & ~removed;
    this.trail.push({ variable: v, removedMask: removed });
    this.domains[v] = next;
    return next !== 0;
  }

  private propagateAllDifferent(scope: number[]): boolean {
    // Remove every singleton's value from the other variables in the scope.
    let singletonMask = 0;
    let singletonCount = 0;
    for (const v of scope) {
      const d = this.domains[v]!;
      if ((d & (d - 1)) === 0) {
        singletonMask |= d;
        singletonCount++;
      }
    }
    // Two singletons forced to the same value violate the constraint.
    if (popcount(singletonMask) < singletonCount) return false;
    for (const v of scope) {
      const d = this.domains[v]!;
      if ((d & (d - 1)) === 0) continue; // singleton itself
      if (!this.removeFromDomain(v, d & singletonMask)) return false;
    }
    return true;
  }

  private propagateTable(scope: number[], tuples: number[][]): boolean {
    // GAC: keep only values that appear in some tuple consistent with current domains.
    const arity = scope.length;
    const supported: number[] = new Array<number>(arity).fill(0);
    for (const tuple of tuples) {
      let consistent = true;
      for (let i = 0; i < arity; i++) {
        if ((this.domains[scope[i]!]! & (1 << tuple[i]!)) === 0) {
          consistent = false;
          break;
        }
      }
      if (!consistent) continue;
      for (let i = 0; i < arity; i++) supported[i]! |= 1 << tuple[i]!;
    }
    for (let i = 0; i < arity; i++) {
      const v = scope[i]!;
      const keep = supported[i]!;
      if (!this.removeFromDomain(v, this.domains[v]! & ~keep)) return false;
    }
    return true;
  }

  /** Run propagation to fixpoint. Returns false on a domain wipe-out. */
  propagate(): boolean {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of this.constraints) {
        const before = this.trail.length;
        const ok =
          c.kind === "allDifferent"
            ? this.propagateAllDifferent(c.scope)
            : this.propagateTable(c.scope, c.tuples);
        if (!ok) return false;
        if (this.trail.length !== before) changed = true;
      }
    }
    return true;
  }

  // ---- trail / undo --------------------------------------------------------

  private mark(): void {
    this.marks.push(this.trail.length);
  }

  /** Restore every domain to the state at the matching mark(). */
  private undo(): void {
    const target = this.marks.pop()!;
    while (this.trail.length > target) {
      const entry = this.trail.pop()!;
      this.domains[entry.variable] = this.domains[entry.variable]! | entry.removedMask;
    }
  }

  // ---- search --------------------------------------------------------------

  private pickVariable(): number {
    let best = -1;
    let bestSize = Infinity;
    for (let v = 0; v < this.numVars; v++) {
      const d = this.domains[v]!;
      const size = popcount(d);
      if (size > 1 && size < bestSize) {
        best = v;
        bestSize = size;
      }
    }
    return best;
  }

  /**
   * Depth-first search.
   * @param mode    "first" stops at the first solution; "all" enumerates all.
   * @param budget  maximum number of search nodes; Infinity for no limit.
   */
  solve(mode: "first" | "all" = "first", budget: number = Infinity): SolveResult {
    let nodes = 0;
    let frontier = 0;
    let solutionCount = 0;
    let firstSolution: number[] | null = null;
    let outOfBudget = false;

    this.mark();
    const rootOk = this.propagate();

    const search = (): boolean => {
      // returns true when the whole remaining tree is exhausted
      if (outOfBudget) return false;
      const v = this.pickVariable();
      if (v === -1) {
        solutionCount++;
        if (firstSolution === null) firstSolution = this.currentAssignment();
        return mode === "all";
      }
      if (nodes >= budget) {
        outOfBudget = true;
        frontier++;
        return false;
      }
      nodes++;
      const values = this.domainOf(v);
      let childrenUnexplored = 0;
      for (const value of values) {
        this.mark();
        const ok = this.removeFromDomain(v, ~(1 << value)) && this.propagate();
        let exhausted = true;
        if (ok) exhausted = search();
        this.undo();
        if (!exhausted) {
          childrenUnexplored++;
          if (mode === "first" && firstSolution !== null) break;
        }
      }
      if (childrenUnexplored > 0) {
        frontier += childrenUnexplored;
        return false;
      }
      return true;
    };

    if (rootOk) {
      search();
    }
    this.undo(); // restore root mark: undoing any branch restores all domains

    let status: SolveStatus;
    if (outOfBudget) {
      status = "unknown";
    } else if (solutionCount > 0) {
      status = "sat";
    } else {
      status = "unsat";
    }
    return { status, solution: firstSolution, solutionCount, nodes, frontier };
  }

  private currentAssignment(): number[] {
    const out: number[] = [];
    for (let v = 0; v < this.numVars; v++) {
      const d = this.domains[v]!;
      out.push(31 - Math.clz32(d & -d));
    }
    return out;
  }
}

function popcount(mask: number): number {
  let count = 0;
  while (mask !== 0) {
    mask &= mask - 1;
    count++;
  }
  return count;
}

/**
 * Independent brute-force enumerator used to cross-check the solver.
 * Enumerates the full Cartesian product without any propagation and keeps
 * assignments satisfying every constraint.
 */
export function enumerateBruteForce(
  domainSizes: number[],
  constraints: Constraint[],
): number[][] {
  const solutions: number[][] = [];
  const assignment = new Array<number>(domainSizes.length).fill(0);

  const satisfies = (): boolean => {
    for (const c of constraints) {
      if (c.kind === "allDifferent") {
        const seen = new Set<number>();
        for (const v of c.scope) {
          const value = assignment[v]!;
          if (seen.has(value)) return false;
          seen.add(value);
        }
      } else {
        const row = c.scope.map((v) => assignment[v]!);
        const ok = c.tuples.some((tuple) => tuple.every((t, i) => t === row[i]));
        if (!ok) return false;
      }
    }
    return true;
  };

  const walk = (v: number): void => {
    if (v === domainSizes.length) {
      if (satisfies()) solutions.push(assignment.slice());
      return;
    }
    for (let value = 0; value < domainSizes[v]!; value++) {
      assignment[v] = value;
      walk(v + 1);
    }
  };
  walk(0);
  return solutions;
}
