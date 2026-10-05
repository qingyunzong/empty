import { evalNaive, parseExpr, varsOf } from "./expr.js";
import { binomial, firstCombination, nextCombination } from "./combo.js";
import { validateProofTree } from "./proof.js";
import type { ConflictCacheEntry, NamedConstraint } from "./solver.js";
import type { StoredResult } from "./state.js";

// Independent verifier. It deliberately uses ONLY the naive per-assignment
// evaluator (never the solver's bigint masks), so a bug in the solver's mask
// arithmetic cannot silently validate itself.

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function naiveSatisfyingIndex(constraints: NamedConstraint[], vars: string[]): number {
  const n = vars.length;
  const index = new Map(vars.map((v, i) => [v, i]));
  const total = 1 << n;
  for (let a = 0; a < total; a++) {
    const get = (name: string): boolean => Boolean((a >> (n - 1 - index.get(name)!)) & 1);
    if (constraints.every((c) => evalNaive(c.expr, get))) return a;
  }
  return -1;
}

export function verifyResult(
  constraints: NamedConstraint[],
  result: StoredResult,
  cache: ConflictCacheEntry[],
): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const byName = new Map(constraints.map((c) => [c.name, c]));
  const names = constraints.map((c) => c.name).sort();

  if (result.status === "unsat") {
    const core = result.core ?? [];
    const missing = core.filter((name) => !byName.has(name));
    checks.push({
      name: "core-members-exist",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `core {${core.join(", ")}} present in input`
          : `missing: ${missing.join(", ")}`,
    });

    if (missing.length === 0) {
      const coreConstraints = core.map((name) => byName.get(name)!);

      // 1. Independent truth table: the core must be unsatisfiable.
      const coreVars = [...new Set(coreConstraints.flatMap((c) => varsOf(c.expr)))].sort();
      const sat = naiveSatisfyingIndex(coreConstraints, coreVars);
      checks.push({
        name: "core-unsat-truth-table",
        ok: sat === -1,
        detail:
          sat === -1
            ? `all ${1 << coreVars.length} assignments falsify at least one core constraint`
            : `core is satisfiable at assignment index ${sat}`,
      });

      // 2. Minimality: every strictly smaller subset of the full merged input
      //    must be satisfiable, each shown by its own truth-table scan.
      let checked = 0;
      let counterexample: string | null = null;
      outer: for (let k = 1; k < core.length; k++) {
        let combo: number[] | null = firstCombination(k);
        while (combo !== null) {
          const subset = combo.map((i) => byName.get(names[i])!);
          const subsetVars = [...new Set(subset.flatMap((c) => varsOf(c.expr)))].sort();
          checked++;
          if (naiveSatisfyingIndex(subset, subsetVars) === -1) {
            counterexample = combo.map((i) => names[i]).join(", ");
            break outer;
          }
          combo = nextCombination(combo, names.length);
        }
      }
      checks.push({
        name: "minimality-all-smaller-subsets-sat",
        ok: counterexample === null,
        detail:
          counterexample === null
            ? `all ${checked} subsets of size < ${core.length} are satisfiable`
            : `smaller unsatisfiable subset exists: {${counterexample}}`,
      });

      // 3. Proof tree: structural replay with the naive evaluator.
      if (result.proof) {
        const validation = validateProofTree(result.proof, coreConstraints, coreVars);
        checks.push({ name: "proof-tree-valid", ok: validation.ok, detail: validation.detail });
      } else {
        checks.push({ name: "proof-tree-valid", ok: false, detail: "no proof tree stored in result" });
      }
    }
  } else {
    // SAT: the stored assignment must satisfy everything, and every
    // lexicographically smaller assignment must falsify some constraint.
    const assignment = result.assignment ?? {};
    const allVars = [...new Set(constraints.flatMap((c) => varsOf(c.expr)))].sort();
    const unknown = Object.keys(assignment).filter((v) => !allVars.includes(v));
    const get = (name: string): boolean => assignment[name] ?? false;
    const satisfied = constraints.every((c) => evalNaive(c.expr, get));
    checks.push({
      name: "assignment-satisfies-all",
      ok: satisfied && unknown.length === 0,
      detail: satisfied
        ? unknown.length === 0
          ? "stored assignment satisfies every constraint"
          : `assignment mentions unknown variables: ${unknown.join(", ")}`
        : "stored assignment falsifies at least one constraint",
    });

    const index = new Map(allVars.map((v, i) => [v, i]));
    const n = allVars.length;
    const claimed = result.assignmentIndex ?? -1;
    let firstSat = -1;
    const total = 1 << n;
    for (let a = 0; a < total; a++) {
      const getA = (name: string): boolean => Boolean((a >> (n - 1 - index.get(name)!)) & 1);
      if (constraints.every((c) => evalNaive(c.expr, getA))) {
        firstSat = a;
        break;
      }
    }
    checks.push({
      name: "assignment-lexicographically-minimal",
      ok: firstSat === claimed,
      detail:
        firstSat === claimed
          ? `all ${claimed} lexicographically smaller assignments falsify some constraint`
          : `truth table finds first satisfying assignment at index ${firstSat}, result claims ${claimed}`,
    });
  }

  // Cache audit: every reusable cached conflict must genuinely be
  // unsatisfiable under the independent truth table.
  let cacheOk = true;
  const cacheDetails: string[] = [];
  for (const entry of cache) {
    const missingSrc = entry.sources.filter((s) => !byName.has(s));
    if (missingSrc.length > 0) {
      cacheDetails.push(`{${entry.sources.join(", ")}} not reusable (missing: ${missingSrc.join(", ")})`);
      continue;
    }
    const subset = entry.sources.map((s) => byName.get(s)!);
    const subsetVars = [...new Set(subset.flatMap((c) => varsOf(c.expr)))].sort();
    if (naiveSatisfyingIndex(subset, subsetVars) !== -1) {
      cacheOk = false;
      cacheDetails.push(`{${entry.sources.join(", ")}} is satisfiable - corrupt cache entry`);
    } else {
      cacheDetails.push(`{${entry.sources.join(", ")}} confirmed unsat`);
    }
  }
  checks.push({
    name: "conflict-cache-sound",
    ok: cacheOk,
    detail: cache.length === 0 ? "cache empty" : cacheDetails.join("; "),
  });

  return checks;
}

export function parseConstraintRecord(record: Record<string, string>): NamedConstraint[] {
  return Object.keys(record)
    .sort()
    .map((name) => ({ name, exprText: record[name], expr: parseExpr(record[name]) }));
}

export function expectedSmallerSubsetCount(totalConstraints: number, coreSize: number): number {
  let count = 0;
  for (let k = 1; k < coreSize; k++) count += binomial(totalConstraints, k);
  return count;
}
