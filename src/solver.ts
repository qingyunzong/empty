import { Expr, fullMask, maskOf, varsOf } from "./expr.js";
import { binomial, firstCombination, nextCombination } from "./combo.js";
import { buildProofTree, renderProofTree, type ProofNode } from "./proof.js";

// Explicit exhaustive-search input limits. With at most 18 named constraints
// and at most 18 distinct variables, the full truth table has at most
// 2^18 = 262144 rows and the subset search inspects at most 2^18 - 1 subsets,
// so every run is a bounded, fully exhaustive enumeration.
export const MAX_CONSTRAINTS = 18;
export const MAX_VARIABLES = 18;

export class LimitError extends Error {}

export interface NamedConstraint {
  name: string;
  exprText: string;
  expr: Expr;
}

export interface Frontier {
  phase: "subset-search";
  k: number; // subset size currently being enumerated
  combo: number[] | null; // next combination to try at size k (null = first)
  stepsDone: number; // subset checks completed in earlier runs
}

export interface SolveStats {
  steps: number; // subset checks performed in this run
  totalSteps: number; // including steps from earlier paused runs
  smallerSubsetsChecked: number; // subsets smaller than the core, all satisfiable
  cacheHit: string[] | null; // cache entry reused as unsat proof / upper bound
}

export interface ConflictCacheEntry {
  sources: string[]; // sorted names of constraints/assumptions forming a minimal conflict
}

export type SolveResult =
  | {
      status: "sat";
      assignment: Record<string, boolean>;
      assignmentIndex: number;
      stats: SolveStats;
    }
  | {
      status: "unsat";
      core: string[];
      proof: ProofNode;
      proofTree: string;
      stats: SolveStats;
    }
  | { status: "paused"; frontier: Frontier; stats: SolveStats };

export interface SolveOptions {
  stepLimit?: number; // pause after this many subset checks in this run
  frontier?: Frontier; // resume point from a previous paused run
  cache?: ConflictCacheEntry[];
  proofMaxLeaves?: number;
}

export function collectVariables(constraints: NamedConstraint[]): string[] {
  const all = new Set<string>();
  for (const c of constraints) for (const v of varsOf(c.expr)) all.add(v);
  return [...all].sort();
}

export function checkLimits(constraints: NamedConstraint[], vars: string[]): void {
  if (constraints.length > MAX_CONSTRAINTS) {
    throw new LimitError(
      `exhaustive input limit exceeded: at most ${MAX_CONSTRAINTS} named constraints are supported (got ${constraints.length})`,
    );
  }
  if (vars.length > MAX_VARIABLES) {
    throw new LimitError(
      `exhaustive input limit exceeded: at most ${MAX_VARIABLES} distinct variables are supported (got ${vars.length})`,
    );
  }
}

export function solve(constraints: NamedConstraint[], options: SolveOptions = {}): SolveResult {
  const names = constraints.map((c) => c.name).sort();
  const byName = new Map(constraints.map((c) => [c.name, c]));
  const vars = collectVariables(constraints);
  checkLimits(constraints, vars);
  const n = vars.length;
  const masks = new Map(names.map((name) => [name, maskOf(byName.get(name)!.expr, vars)]));

  // Minimal-conflict cache: an old conflict is reusable only if every one of
  // its sources still exists in the current merged input (this is exactly the
  // rule that protects the cache after an assumption is retracted). A valid
  // entry proves UNSAT and caps the core size we need to search up to.
  const frontier = options.frontier;
  const priorSteps = frontier?.stepsDone ?? 0;
  let steps = 0;

  // Minimal-conflict cache: an old conflict is reusable only if every one of
  // its sources still exists in the current merged input (this is exactly the
  // rule that protects the cache after an assumption is retracted). A valid
  // entry proves UNSAT and caps the core size we need to search up to.
  let upperBound = names.length;
  let cacheHit: string[] | null = null;
  for (const entry of options.cache ?? []) {
    if (entry.sources.length === 0) continue;
    if (!entry.sources.every((s) => byName.has(s))) continue; // sources not all present: not reusable
    let and = fullMask(n);
    for (const s of entry.sources) and &= masks.get(s)!;
    if (and !== 0n) continue; // stale/corrupt entry: never trust it
    if (entry.sources.length <= upperBound) {
      upperBound = entry.sources.length;
      cacheHit = entry.sources;
    }
  }

  // Fast satisfiability check: if the joint truth mask has any set bit, the
  // whole set is satisfiable and no subset search is needed at all.
  if (cacheHit === null && frontier === undefined) {
    let joint = fullMask(n);
    for (const name of names) joint &= masks.get(name)!;
    if (joint !== 0n) {
      // The lowest set bit is the lexicographically smallest satisfying
      // assignment (see expr.ts for the bit/lexicographic correspondence).
      let assignmentIndex = 0;
      let scan = joint;
      while ((scan & 1n) === 0n) {
        scan >>= 1n;
        assignmentIndex++;
      }
      const assignment: Record<string, boolean> = {};
      for (let j = 0; j < n; j++) {
        assignment[vars[j]] = Boolean((assignmentIndex >> (n - 1 - j)) & 1);
      }
      return {
        status: "sat",
        assignment,
        assignmentIndex,
        stats: { steps, totalSteps: priorSteps, smallerSubsetsChecked: 0, cacheHit },
      };
    }
  }

  // The set is unsatisfiable: find the minimum-cardinality unsat subset,
  // breaking ties by the lexicographically smallest sorted ID list. Sizes are
  // enumerated ascending and combinations in lexicographic order, so the
  // first unsatisfiable subset found is exactly that subset.
  const startK = frontier?.k ?? 1;
  let core: string[] | null = null;
  outer: for (let k = startK; k <= upperBound; k++) {
    let combo: number[] | null =
      frontier && k === startK && frontier.combo ? frontier.combo.slice() : firstCombination(k);
    while (combo !== null) {
      if (options.stepLimit !== undefined && steps >= options.stepLimit) {
        return {
          status: "paused",
          frontier: { phase: "subset-search", k, combo, stepsDone: priorSteps + steps },
          stats: {
            steps,
            totalSteps: priorSteps + steps,
            smallerSubsetsChecked: 0,
            cacheHit,
          },
        };
      }
      steps++;
      let and = fullMask(n);
      for (const idx of combo) and &= masks.get(names[idx])!;
      if (and === 0n) {
        core = combo.map((i) => names[i]);
        break outer;
      }
      combo = nextCombination(combo, names.length);
    }
  }

  if (core !== null) {
    let smallerSubsetsChecked = 0;
    for (let i = 1; i < core.length; i++) smallerSubsetsChecked += binomial(names.length, i);
    const coreConstraints = core.map((name) => byName.get(name)!);
    const proof = buildProofTree(coreConstraints, vars);
    return {
      status: "unsat",
      core,
      proof,
      proofTree: renderProofTree(proof, core, options.proofMaxLeaves ?? 512),
      stats: { steps, totalSteps: priorSteps + steps, smallerSubsetsChecked, cacheHit },
    };
  }

  // Unreachable in practice: with no cache hit the search covers every subset
  // up to the full set, which is itself unsatisfiable, so a core is always
  // found. A corrupt cache could in theory cap the search below the true
  // core size; fail closed by reporting the cache entry itself.
  if (cacheHit !== null) {
    const coreConstraints = cacheHit.map((name) => byName.get(name)!);
    const proof = buildProofTree(coreConstraints, vars);
    return {
      status: "unsat",
      core: cacheHit.slice().sort(),
      proof,
      proofTree: renderProofTree(proof, cacheHit, options.proofMaxLeaves ?? 512),
      stats: { steps, totalSteps: priorSteps + steps, smallerSubsetsChecked: 0, cacheHit },
    };
  }
  throw new Error("internal error: unsatisfiable set produced no core");
}
