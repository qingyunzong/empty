import type { Problem, SolveResult } from "./types.js";

/**
 * Independent verifier. Deliberately shares no logic with the solver: it only
 * re-checks the mathematical certificates from first principles.
 *
 * Optimal case (LP duality for the assignment problem):
 *   1. matching is a permutation, every matched edge allowed;
 *   2. reported cost equals the sum of matched edge costs;
 *   3. dual feasibility: u[i] + v[j] <= c[i][j] for every ALLOWED edge;
 *   4. complementary slackness: equality on every matched edge;
 *   5. sum(u) + sum(v) == cost, so the dual bound certifies optimality.
 *
 * Infeasible case (Hall's theorem):
 *   recomputes N(S) for the witness row set S and checks |N(S)| < |S|,
 *   which proves no perfect matching exists.
 */
export function verify(problem: Problem, result: SolveResult): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const n = problem.orders.length;
  let maxAbs = 1;
  for (const row of problem.costs) for (const c of row) if (c !== null) maxAbs = Math.max(maxAbs, Math.abs(c));
  const eps = 1e-9 * maxAbs;

  if (result.status === "optimal") {
    const { matching, cost, dual } = result;
    if (matching.length !== n) errors.push(`matching length ${matching.length} != n ${n}`);
    const seenCols = new Set<number>();
    let sum = 0;
    for (let i = 0; i < Math.min(matching.length, n); i++) {
      const j = matching[i]!;
      if (!Number.isInteger(j) || j < 0 || j >= n) {
        errors.push(`matching[${i}] = ${j} is not a valid station index`);
        continue;
      }
      if (seenCols.has(j)) errors.push(`station ${j} assigned more than once`);
      seenCols.add(j);
      const c = problem.costs[i]![j]!;
      if (c === null) {
        errors.push(`matched edge (${i}, ${j}) is forbidden`);
      } else {
        sum += c;
      }
    }
    if (Math.abs(sum - cost) > eps) errors.push(`reported cost ${cost} != sum of matched edges ${sum}`);
    if (dual.u.length !== n || dual.v.length !== n) errors.push("dual vectors must have length n");
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const c = problem.costs[i]![j]!;
        if (c === null) continue; // no constraint for forbidden edges
        const lhs = dual.u[i]! + dual.v[j]!;
        if (lhs > c + eps) errors.push(`dual infeasible at (${i}, ${j}): u+v = ${lhs} > c = ${c}`);
      }
    }
    for (let i = 0; i < n; i++) {
      const j = matching[i]!;
      if (j < 0 || j >= n) continue;
      const c = problem.costs[i]![j]!;
      if (c === null) continue;
      const lhs = dual.u[i]! + dual.v[j]!;
      if (Math.abs(lhs - c) > eps) errors.push(`no complementary slackness at matched (${i}, ${j}): u+v = ${lhs}, c = ${c}`);
    }
    const dualObj = dual.u.reduce((a, b) => a + b, 0) + dual.v.reduce((a, b) => a + b, 0);
    if (Math.abs(dualObj - cost) > eps) errors.push(`dual objective ${dualObj} != primal cost ${cost}`);
  } else {
    const { hall } = result;
    const rows = [...new Set(hall.rows)];
    if (rows.length === 0) errors.push("Hall witness row set is empty");
    for (const i of rows) {
      if (!Number.isInteger(i) || i < 0 || i >= n) errors.push(`Hall witness row ${i} out of range`);
    }
    // Independently recompute N(S).
    const neighborhood = new Set<number>();
    for (const i of rows) {
      if (i < 0 || i >= n) continue;
      for (let j = 0; j < n; j++) {
        if (problem.costs[i]![j] !== null) neighborhood.add(j);
      }
    }
    const reported = new Set(hall.neighbors);
    const same = neighborhood.size === reported.size && [...neighborhood].every((j) => reported.has(j));
    if (!same) {
      errors.push(`reported neighbors ${[...reported].sort()} != recomputed N(S) ${[...neighborhood].sort()}`);
    }
    if (!(neighborhood.size < rows.length)) {
      errors.push(`not a Hall violation: |N(S)| = ${neighborhood.size} >= |S| = ${rows.length}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
