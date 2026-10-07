import type { Expr } from "./ast.js";
import { evaluate } from "./eval.js";

/** Hard, explicit input limits for the exhaustive algorithms. */
export const MAX_CONSTRAINTS = 18; // subset space is 2^18 = 262144
export const MAX_VARS = 20; // truth table is 2^20 = 1048576 rows

export interface SolveOptions {
  /** Variables in canonical (sorted) order; index 0 is most significant. */
  vars: readonly string[];
  /** Truth-table row to resume from (the persisted frontier). */
  startIndex?: number;
  /** Maximum number of rows to test in this call before pausing. */
  stepBudget?: number;
}

export type SolveOutcome =
  | { status: "sat"; assignment: Record<string, boolean>; rowIndex: number; steps: number }
  | { status: "unsat"; steps: number }
  | { status: "paused"; nextRowIndex: number; steps: number };

/**
 * Maps a truth-table row number to an assignment. Variable vars[0] is the
 * most significant bit, so scanning rows 0,1,2,... enumerates assignments
 * in lexicographic order with false < true.
 */
export function assignmentAtRow(vars: readonly string[], row: number): Record<string, boolean> {
  const n = vars.length;
  const out: Record<string, boolean> = {};
  for (let k = 0; k < n; k++) {
    out[vars[k] as string] = ((row >> (n - 1 - k)) & 1) === 1;
  }
  return out;
}

/**
 * Exhaustive truth-table scan for a satisfying row of the conjunction of
 * `exprs`. Returns the lexicographically smallest satisfying assignment,
 * `unsat` after the full table, or `paused` with the frontier row to
 * persist when the step budget is exhausted.
 */
export function solveConjunction(exprs: readonly Expr[], opts: SolveOptions): SolveOutcome {
  const n = opts.vars.length;
  if (n > MAX_VARS) {
    throw new Error(
      `exhaustive input limit exceeded: ${n} variables, at most ${MAX_VARS} allowed (2^${MAX_VARS} rows)`
    );
  }
  const totalRows = 2 ** n;
  const start = opts.startIndex ?? 0;
  let steps = 0;
  for (let row = start; row < totalRows; row++) {
    if (opts.stepBudget !== undefined && steps >= opts.stepBudget) {
      return { status: "paused", nextRowIndex: row, steps };
    }
    steps++;
    const assignment = assignmentAtRow(opts.vars, row);
    const get = (name: string): boolean => assignment[name] ?? false;
    let all = true;
    for (const e of exprs) {
      if (!evaluate(e, get)) {
        all = false;
        break;
      }
    }
    if (all) return { status: "sat", assignment, rowIndex: row, steps };
  }
  return { status: "unsat", steps };
}
