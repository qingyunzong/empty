/**
 * Finite-domain CSP solver for up to 16 variables.
 *
 * Constraints: allDifferent, table (extensional, allowed tuples).
 * Propagation: fixpoint of singleton-removal (allDifferent) and GAC support
 * pruning (table). Every domain narrowing is recorded on a trail, so undoing
 * a branch restores all domains exactly.
 *
 * Search: depth-first, MRV variable selection, one "search node" per branch
 * point. A node budget bounds the search; exhausting it yields a CUTOFF
 * result carrying the unclosed frontier (untried alternatives along the
 * current path). Otherwise the result is SAT (with solution(s)) or UNSAT
 * (with the complete, fully failed search tree).
 */

export const MAX_VARIABLES = 16;

export interface AllDifferentConstraint {
  kind: 'allDifferent';
  variables: number[];
}

export interface TableConstraint {
  kind: 'table';
  variables: number[];
  tuples: number[][];
}

export type Constraint = AllDifferentConstraint | TableConstraint;

export interface Problem {
  domains: number[][];
  constraints: Constraint[];
}

export interface Decision {
  variable: number;
  value: number;
}

/** An open branch point: untried candidate values under a partial assignment. */
export interface FrontierEntry {
  path: Decision[];
  variable: number;
  candidates: number[];
}

export type TreeNodeStatus = 'failed' | 'exhausted' | 'solution' | 'open';

export interface TreeNode {
  /** Assignment that led to this node; null at the root. */
  decision: Decision | null;
  /**
   * failed:    propagation emptied a domain (leaf).
   * solution:  all variables assigned (leaf).
   * exhausted: every child explored, none a solution (internal).
   * open:      not fully explored (budget cut or early SAT exit).
   */
  status: TreeNodeStatus;
  children: TreeNode[];
}

export interface SolveOptions {
  /** Maximum number of branch nodes to expand. Default: unbounded. */
  budget?: number;
  /** Collect all solutions instead of stopping at the first. Default: false. */
  findAll?: boolean;
  /** Record the search tree. Default: true. */
  recordTree?: boolean;
}

export type SolveStatus = 'SAT' | 'UNSAT' | 'CUTOFF';

export interface SolveResult {
  status: SolveStatus;
  /** Number of branch nodes actually expanded. */
  nodes: number;
  /** Deepest decision path length reached. */
  maxDepth: number;
  /** Solutions found (one for SAT unless findAll was set). */
  solutions: number[][];
  /** Unclosed frontier; non-empty only for CUTOFF. */
  frontier: FrontierEntry[];
  /** Search tree (null when recordTree was false). Complete for UNSAT. */
  tree: TreeNode | null;
}

export function validateProblem(problem: Problem): void {
  if (!problem || !Array.isArray(problem.domains)) {
    throw new Error('problem.domains must be an array');
  }
  const n = problem.domains.length;
  if (n === 0) throw new Error('problem must have at least one variable');
  if (n > MAX_VARIABLES) {
    throw new Error(`at most ${MAX_VARIABLES} variables supported, got ${n}`);
  }
  problem.domains.forEach((domain, i) => {
    if (!Array.isArray(domain) || domain.length === 0) {
      throw new Error(`domain of variable ${i} must be a non-empty array`);
    }
    for (const v of domain) {
      if (!Number.isInteger(v)) {
        throw new Error(`domain of variable ${i} must contain only integers`);
      }
    }
    if (new Set(domain).size !== domain.length) {
      throw new Error(`domain of variable ${i} contains duplicate values`);
    }
  });
  for (const c of problem.constraints) {
    if (c.kind === 'allDifferent') {
      if (c.variables.length < 2) {
        throw new Error('allDifferent needs at least two variables');
      }
      checkScope(c.variables, n);
      if (new Set(c.variables).size !== c.variables.length) {
        throw new Error('allDifferent scope contains duplicate variables');
      }
    } else if (c.kind === 'table') {
      if (c.variables.length === 0) {
        throw new Error('table constraint needs a non-empty scope');
      }
      checkScope(c.variables, n);
      for (const tuple of c.tuples) {
        if (tuple.length !== c.variables.length) {
          throw new Error('table tuple arity does not match its scope');
        }
        for (const v of tuple) {
          if (!Number.isInteger(v)) {
            throw new Error('table tuples must contain only integers');
          }
        }
      }
    } else {
      throw new Error(`unknown constraint kind: ${(c as Constraint).kind}`);
    }
  }
}

function checkScope(variables: number[], n: number): void {
  for (const v of variables) {
    if (!Number.isInteger(v) || v < 0 || v >= n) {
      throw new Error(`constraint references invalid variable index ${v}`);
    }
  }
}

class BudgetExhausted extends Error {}

interface Frame {
  variable: number;
  path: Decision[];
  remaining: number[];
}

export class Solver {
  readonly problem: Problem;
  private domains: Set<number>[];
  private readonly initialDomains: number[][];
  private trail: { variable: number; value: number }[] = [];
  private nodes = 0;
  private maxDepth = 0;
  private readonly budget: number;
  private readonly findAll: boolean;
  private readonly recordTree: boolean;
  private solutions: number[][] = [];
  private frontier: FrontierEntry[] = [];
  private openStack: Frame[] = [];

  constructor(problem: Problem, options: SolveOptions = {}) {
    validateProblem(problem);
    this.problem = problem;
    this.initialDomains = problem.domains.map((d) => [...d]);
    this.domains = problem.domains.map((d) => new Set(d));
    this.budget = options.budget ?? Number.POSITIVE_INFINITY;
    this.findAll = options.findAll ?? false;
    this.recordTree = options.recordTree ?? true;
  }

  /** Current live domains (sorted copies). After solve() these equal the initial domains. */
  currentDomains(): number[][] {
    return this.domains.map((d) => [...d].sort((a, b) => a - b));
  }

  initialDomainCopies(): number[][] {
    return this.initialDomains.map((d) => [...d]);
  }

  solve(): SolveResult {
    const root: TreeNode = { decision: null, status: 'open', children: [] };
    let cutoff = false;
    try {
      this.dfs([], this.recordTree ? root : null);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        cutoff = true;
      } else {
        throw err;
      }
    }
    const status: SolveStatus = cutoff
      ? 'CUTOFF'
      : this.solutions.length > 0
        ? 'SAT'
        : 'UNSAT';
    return {
      status,
      nodes: this.nodes,
      maxDepth: this.maxDepth,
      solutions: this.solutions,
      frontier: cutoff ? this.frontier : [],
      tree: this.recordTree ? root : null,
    };
  }

  /** Returns true if the subtree below contains a solution. */
  private dfs(path: Decision[], treeNode: TreeNode | null): boolean {
    const checkpoint = this.trail.length;
    try {
      if (!this.propagate()) {
        if (treeNode) treeNode.status = 'failed';
        return false;
      }
      if (path.length > this.maxDepth) this.maxDepth = path.length;

      const variable = this.pickVariable();
      if (variable === -1) {
        const solution = this.domains.map((d) => d.values().next().value as number);
        this.solutions.push(solution);
        if (treeNode) treeNode.status = 'solution';
        return true;
      }

      const values = [...this.domains[variable]];
      if (this.nodes >= this.budget) {
        if (treeNode) treeNode.status = 'open';
        this.frontier = this.buildFrontier(path, variable, values);
        throw new BudgetExhausted();
      }
      this.nodes++;

      const frame: Frame = {
        variable,
        path: path.map((d) => ({ ...d })),
        remaining: values.slice(1),
      };
      this.openStack.push(frame);
      let found = false;
      let brokeEarly = false;
      try {
        for (let i = 0; i < values.length; i++) {
          frame.remaining = values.slice(i + 1);
          let child: TreeNode | null = null;
          if (treeNode) {
            child = {
              decision: { variable, value: values[i] },
              status: 'open',
              children: [],
            };
            treeNode.children.push(child);
          }
          const branchCheckpoint = this.trail.length;
          this.assign(variable, values[i]);
          path.push({ variable, value: values[i] });
          const subFound = this.dfs(path, child);
          path.pop();
          this.restore(branchCheckpoint);
          if (subFound) {
            found = true;
            if (!this.findAll) {
              brokeEarly = true;
              break;
            }
          }
        }
      } finally {
        this.openStack.pop();
      }
      if (treeNode) treeNode.status = brokeEarly ? 'open' : 'exhausted';
      return found;
    } finally {
      this.restore(checkpoint);
    }
  }

  private buildFrontier(path: Decision[], variable: number, values: number[]): FrontierEntry[] {
    const entries: FrontierEntry[] = [];
    for (const frame of this.openStack) {
      if (frame.remaining.length > 0) {
        entries.push({
          path: frame.path.map((d) => ({ ...d })),
          variable: frame.variable,
          candidates: [...frame.remaining],
        });
      }
    }
    entries.push({
      path: path.map((d) => ({ ...d })),
      variable,
      candidates: [...values],
    });
    return entries;
  }

  /** Fixpoint propagation. Returns false as soon as any domain empties. */
  private propagate(): boolean {
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of this.problem.constraints) {
        if (c.kind === 'allDifferent') {
          if (!this.propagateAllDifferent(c.variables)) return false;
          changed = changed || this.lastPruned;
        } else {
          if (!this.propagateTable(c)) return false;
          changed = changed || this.lastPruned;
        }
      }
    }
    return true;
  }

  private lastPruned = false;

  private propagateAllDifferent(variables: number[]): boolean {
    const singletons = new Set<number>();
    for (const v of variables) {
      const d = this.domains[v];
      if (d.size === 1) {
        const val = d.values().next().value as number;
        if (singletons.has(val)) return false;
        singletons.add(val);
      }
    }
    this.lastPruned = false;
    for (const v of variables) {
      const d = this.domains[v];
      if (d.size <= 1) continue;
      for (const val of singletons) {
        if (d.has(val)) this.remove(v, val);
      }
      if (d.size === 0) return false;
    }
    return true;
  }

  private propagateTable(c: TableConstraint): boolean {
    const scope = c.variables;
    const valid = c.tuples.filter((tuple) =>
      scope.every((v, i) => this.domains[v].has(tuple[i])),
    );
    this.lastPruned = false;
    for (let i = 0; i < scope.length; i++) {
      const v = scope[i];
      const supported = new Set<number>();
      for (const tuple of valid) supported.add(tuple[i]);
      for (const val of [...this.domains[v]]) {
        if (!supported.has(val)) this.remove(v, val);
      }
      if (this.domains[v].size === 0) return false;
    }
    return true;
  }

  private remove(variable: number, value: number): void {
    if (this.domains[variable].delete(value)) {
      this.trail.push({ variable, value });
      this.lastPruned = true;
    }
  }

  private assign(variable: number, value: number): void {
    for (const val of [...this.domains[variable]]) {
      if (val !== value) this.remove(variable, val);
    }
  }

  private restore(checkpoint: number): void {
    while (this.trail.length > checkpoint) {
      const entry = this.trail.pop() as { variable: number; value: number };
      this.domains[entry.variable].add(entry.value);
    }
  }

  /** MRV: smallest non-singleton domain, ties broken by lowest index. */
  private pickVariable(): number {
    let best = -1;
    let bestSize = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.domains.length; i++) {
      const size = this.domains[i].size;
      if (size > 1 && size < bestSize) {
        best = i;
        bestSize = size;
      }
    }
    return best;
  }
}

export function solve(problem: Problem, options: SolveOptions = {}): SolveResult {
  return new Solver(problem, options).solve();
}
