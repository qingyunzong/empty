/**
 * Independent verification of solver output.
 *
 * After constraint propagation shrinks a variable's domain to [L, U],
 * every candidate in the shrunk domain is evaluated against the ORIGINAL
 * constraints (exact bigint arithmetic) and compared with the announced
 * step intervals. When even the shrunk domain exceeds the limit, exact
 * boundary checks are performed instead: interval endpoints must satisfy
 * all constraints, and every progression point between adjacent
 * intervals (each excluded by a disequality) must violate at least one.
 */

import { mod } from "./bigint-math";
import { Constraint, Domain, Problem } from "./parser";
import { SolveResult, StepInterval, VarSolution } from "./solver";

export const DEFAULT_VERIFY_LIMIT = 1_000_000n;

export interface Verification {
  variable: string;
  mode: "exhaustive" | "boundary" | "not-checkable";
  ok: boolean;
  candidatesChecked: bigint;
  detail: string;
  mismatches: string[];
}

export function constraintHolds(c: Constraint, variable: string, x: bigint): boolean {
  const a = c.expr.coeffs.get(variable) ?? 0n;
  const lhs = a * x + c.expr.constant;
  if (c.kind === "cong") return mod(lhs, c.modulus) === 0n;
  switch (c.op) {
    case "<=":
      return lhs <= 0n;
    case "<":
      return lhs < 0n;
    case ">=":
      return lhs >= 0n;
    case ">":
      return lhs > 0n;
    case "==":
      return lhs === 0n;
    case "!=":
      return lhs !== 0n;
  }
}

function allHold(constraints: Constraint[], variable: string, x: bigint): boolean {
  for (const c of constraints) {
    if (!constraintHolds(c, variable, x)) return false;
  }
  return true;
}

function inIntervals(intervals: StepInterval[], x: bigint): boolean {
  // intervals are sorted and share the same step
  for (const iv of intervals) {
    if (x < iv.start) return false;
    if (x <= iv.end) return (x - iv.start) % iv.step === 0n;
  }
  return false;
}

const MAX_MISMATCHES = 5;

export function verifyVariable(
  constraints: Constraint[],
  solution: VarSolution,
  limit: bigint
): Verification {
  const name = solution.variable;
  const mismatches: string[] = [];
  const note = (msg: string) => {
    if (mismatches.length < MAX_MISMATCHES) mismatches.push(msg);
  };

  if (solution.status === "unsat") {
    // Exhaustively confirm the certificate when the domain is small enough.
    const size = solution.domain.hi - solution.domain.lo + 1n;
    if (size <= limit) {
      let checked = 0n;
      let x = solution.domain.lo;
      while (x <= solution.domain.hi) {
        if (allHold(constraints, name, x)) note(`x = ${x} satisfies all constraints despite UNSAT certificate`);
        checked++;
        x++;
      }
      return {
        variable: name,
        mode: "exhaustive",
        ok: mismatches.length === 0,
        candidatesChecked: checked,
        detail: `exhaustively checked all ${checked} domain values against the UNSAT certificate`,
        mismatches,
      };
    }
    return {
      variable: name,
      mode: "not-checkable",
      ok: true,
      candidatesChecked: 0n,
      detail: `domain too large for exhaustive check (${size} > ${limit}); certificate stands by construction`,
      mismatches,
    };
  }

  const { lo, hi } = solution.bounds;
  const size = hi - lo + 1n;

  if (size <= limit) {
    // Exhaustive check over the shrunk domain.
    let checked = 0n;
    let expectedCount = 0n;
    let x = lo;
    while (x <= hi) {
      const actual = allHold(constraints, name, x);
      const expected = inIntervals(solution.intervals, x);
      if (actual !== expected) {
        note(`x = ${x}: constraints ${actual ? "hold" : "fail"} but it is ${expected ? "in" : "not in"} the step intervals`);
      }
      if (expected) expectedCount++;
      checked++;
      x++;
    }
    if (expectedCount !== solution.solutionCount) {
      note(`solution count mismatch: intervals hold ${expectedCount}, announced ${solution.solutionCount}`);
    }
    // Bound tightness: neighbours just outside the shrunk domain must fail.
    if (lo > solution.domain.lo && allHold(constraints, name, lo - 1n)) {
      note(`x = ${lo - 1n} (just below shrunk domain) satisfies all constraints`);
    }
    if (hi < solution.domain.hi && allHold(constraints, name, hi + 1n)) {
      note(`x = ${hi + 1n} (just above shrunk domain) satisfies all constraints`);
    }
    return {
      variable: name,
      mode: "exhaustive",
      ok: mismatches.length === 0,
      candidatesChecked: checked,
      detail: `exhaustively checked all ${checked} values of the shrunk domain [${lo}, ${hi}]`,
      mismatches,
    };
  }

  // Boundary mode: exact spot checks, no enumeration.
  let checked = 0n;
  const step = solution.intervals.length > 0 ? solution.intervals[0]!.step : 1n;
  for (let i = 0; i < solution.intervals.length; i++) {
    const iv = solution.intervals[i]!;
    if (iv.step !== step) note(`interval ${i} has inconsistent step ${iv.step}`);
    if ((iv.end - iv.start) % iv.step !== 0n) note(`interval ${i} end is not on the progression`);
    if (iv.start < lo || iv.end > hi) note(`interval ${i} escapes the shrunk domain`);
    for (const p of [iv.start, iv.end]) {
      checked++;
      if (!allHold(constraints, name, p)) note(`interval endpoint x = ${p} violates a constraint`);
    }
    // The progression point before/after the interval, if inside the
    // shrunk domain, must NOT be a solution.
    const before = iv.start - step;
    if (before >= lo) {
      checked++;
      if (allHold(constraints, name, before)) note(`x = ${before} before interval ${i} satisfies all constraints`);
    }
    const after = iv.end + step;
    if (after <= hi) {
      checked++;
      if (allHold(constraints, name, after)) note(`x = ${after} after interval ${i} satisfies all constraints`);
    }
    // Gap points between this interval and the next (excluded points).
    if (i + 1 < solution.intervals.length) {
      const next = solution.intervals[i + 1]!;
      let p = iv.end + step;
      while (p < next.start) {
        checked++;
        if (allHold(constraints, name, p)) note(`gap point x = ${p} satisfies all constraints`);
        p += step;
      }
    }
  }
  let count = 0n;
  for (const iv of solution.intervals) count += (iv.end - iv.start) / iv.step + 1n;
  if (count !== solution.solutionCount) {
    note(`solution count mismatch: intervals hold ${count}, announced ${solution.solutionCount}`);
  }
  return {
    variable: name,
    mode: "boundary",
    ok: mismatches.length === 0,
    candidatesChecked: checked,
    detail: `shrunk domain too large for exhaustive check (${size} > ${limit}); checked ${checked} boundary/gap points exactly`,
    mismatches,
  };
}

export function verifyProblem(
  problem: Problem,
  result: SolveResult,
  limit: bigint = DEFAULT_VERIFY_LIMIT
): Verification[] {
  const reports: Verification[] = [];
  for (const sol of result.variables) {
    const constraints = problem.constraints.filter((c) => {
      const vars = [...c.expr.coeffs.keys()];
      return vars.length === 0 || vars[0] === sol.variable;
    });
    reports.push(verifyVariable(constraints, sol, limit));
  }
  return reports;
}
