import type { Expr } from "./ast.js";
import { evaluateIndependent } from "./eval.js";
import type { NamedExpr } from "./mus.js";
import { assignmentAtRow } from "./solver.js";

export interface VerifyReport {
  ok: boolean;
  lines: string[];
}

function subsetExprs(named: readonly NamedExpr[], ids: readonly string[]): Expr[] {
  const byId = new Map(named.map((c) => [c.id, c.expr]));
  return ids.map((id) => {
    const e = byId.get(id);
    if (e === undefined) throw new Error(`unknown constraint id '${id}'`);
    return e;
  });
}

/** Independent truth-table scan: returns the first satisfying row, or -1. */
function firstSatisfyingRow(exprs: readonly Expr[], vars: readonly string[]): number {
  const total = 2 ** vars.length;
  for (let row = 0; row < total; row++) {
    const assignment = assignmentAtRow(vars, row);
    const get = (name: string): boolean => assignment[name] ?? false;
    let all = true;
    for (const e of exprs) {
      if (!evaluateIndependent(e, get)) {
        all = false;
        break;
      }
    }
    if (all) return row;
  }
  return -1;
}

function popcount(x: number): number {
  let c = 0;
  let v = x;
  while (v !== 0) {
    v &= v - 1;
    c++;
  }
  return c;
}

/**
 * Independently verifies an unsatisfiability claim for `mus`:
 *  1. re-runs a full truth table over the MUS with the independent
 *     (postfix, stack-based) evaluator and requires UNSAT;
 *  2. enumerates every subset of the whole input with size < |mus| via
 *     bitmask enumeration (a different generator than the search uses)
 *     and requires each to be satisfiable.
 */
export function verifyUnsatClaim(
  named: readonly NamedExpr[],
  vars: readonly string[],
  mus: readonly string[]
): VerifyReport {
  const lines: string[] = [];
  let ok = true;

  const musRow = firstSatisfyingRow(subsetExprs(named, mus), vars);
  if (musRow === -1) {
    lines.push(`PASS independent truth table: {${mus.join(", ")}} has no satisfying row`);
  } else {
    ok = false;
    lines.push(`FAIL independent truth table: {${mus.join(", ")}} is satisfied at row ${musRow}`);
  }

  const ids = named.map((c) => c.id);
  let smallerCount = 0;
  let badSubset: string[] | null = null;
  const totalMasks = 2 ** ids.length;
  for (let mask = 0; mask < totalMasks; mask++) {
    if (popcount(mask) >= mus.length) continue;
    const subset = ids.filter((_, i) => ((mask >> i) & 1) === 1);
    smallerCount++;
    if (firstSatisfyingRow(subsetExprs(named, subset), vars) === -1) {
      badSubset = subset;
      break;
    }
  }
  if (badSubset === null) {
    lines.push(
      `PASS all ${smallerCount} subset(s) of size < ${mus.length} independently verified satisfiable`
    );
  } else {
    ok = false;
    lines.push(`FAIL subset {${badSubset.join(", ")}} of size < ${mus.length} is unsatisfiable`);
  }
  return { ok, lines };
}

/**
 * Independently verifies a satisfiability claim: the assignment must
 * satisfy every constraint, and no lexicographically smaller assignment
 * may satisfy them.
 */
export function verifySatClaim(
  named: readonly NamedExpr[],
  vars: readonly string[],
  assignment: Record<string, boolean>
): VerifyReport {
  const lines: string[] = [];
  let ok = true;
  const exprs = named.map((c) => c.expr);
  const get = (name: string): boolean => assignment[name] ?? false;
  const holds = exprs.every((e) => evaluateIndependent(e, get));
  if (holds) {
    lines.push("PASS independent evaluation: assignment satisfies all constraints");
  } else {
    ok = false;
    lines.push("FAIL independent evaluation: assignment violates a constraint");
  }

  // Locate the row of the claimed assignment, then rescan all smaller rows.
  const total = 2 ** vars.length;
  let claimedRow = -1;
  for (let row = 0; row < total; row++) {
    const candidate = assignmentAtRow(vars, row);
    if (vars.every((v) => (candidate[v] ?? false) === (assignment[v] ?? false))) {
      claimedRow = row;
      break;
    }
  }
  if (claimedRow === -1) {
    ok = false;
    lines.push("FAIL claimed assignment not representable over the variable set");
    return { ok, lines };
  }
  let smallerSatRow = -1;
  for (let row = 0; row < claimedRow; row++) {
    const candidate = assignmentAtRow(vars, row);
    const lookup = (name: string): boolean => candidate[name] ?? false;
    if (exprs.every((e) => evaluateIndependent(e, lookup))) {
      smallerSatRow = row;
      break;
    }
  }
  if (smallerSatRow === -1) {
    lines.push(`PASS all ${claimedRow} lexicographically smaller assignment(s) checked: none satisfies`);
  } else {
    ok = false;
    lines.push(`FAIL lexicographically smaller satisfying assignment exists at row ${smallerSatRow}`);
  }
  return { ok, lines };
}
