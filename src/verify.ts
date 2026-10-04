/**
 * 独立验证器：不调用求解器，仅凭问题实例与输出证书逐项校验。
 * - optimal：匹配是双射、无禁配、费用一致；对偶可行（u_i+v_j<=c_ij）、
 *   匹配边紧（等号）、对偶目标和 = 原始目标值（强对偶）。
 * - infeasible：Hall 见证 S 满足 |N(S)| < |S|。
 */
import type { Problem, SolveResult } from "./solver.js";

const EPS = 1e-9;

export interface VerifyReport {
  ok: boolean;
  checks: string[];
  errors: string[];
}

export function verifySolution(problem: Problem, result: SolveResult): VerifyReport {
  const checks: string[] = [];
  const errors: string[] = [];
  const n = problem.orderIds.length;

  if (result.status === "optimal") {
    const { match, cost, dual } = result;
    if (match.length !== n) errors.push(`matching length ${match.length} != n=${n}`);

    const seen = new Set<number>();
    let bijective = true;
    for (let i = 0; i < n; i++) {
      const j = match[i];
      if (!Number.isInteger(j) || j < 0 || j >= n || seen.has(j)) bijective = false;
      seen.add(j);
    }
    if (bijective && seen.size === n) checks.push("matching is a bijection (one-to-one)");
    else errors.push("matching is not a bijection");

    let noForbidden = true;
    for (let i = 0; i < n; i++) if (!problem.allowed[i][match[i]]) noForbidden = false;
    if (noForbidden) checks.push("no forbidden pair used");
    else errors.push("matching uses a forbidden pair");

    let recomputed = 0;
    for (let i = 0; i < n; i++) recomputed += problem.cost[i][match[i]];
    if (Math.abs(recomputed - cost) <= EPS) checks.push(`cost consistent: ${cost}`);
    else errors.push(`cost mismatch: claimed ${cost}, recomputed ${recomputed}`);

    if (dual.u.length !== n || dual.v.length !== n) {
      errors.push("dual vector length mismatch");
    } else {
      let dualFeasible = true;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (problem.allowed[i][j] && dual.u[i] + dual.v[j] > problem.cost[i][j] + EPS)
            dualFeasible = false;
      if (dualFeasible) checks.push("dual feasible: u_i + v_j <= c_ij on all allowed pairs");
      else errors.push("dual infeasible: some allowed pair violates u_i + v_j <= c_ij");

      let tight = true;
      for (let i = 0; i < n; i++) {
        const j = match[i];
        if (Math.abs(dual.u[i] + dual.v[j] - problem.cost[i][j]) > EPS) tight = false;
      }
      if (tight) checks.push("complementary slackness: matched edges are tight");
      else errors.push("matched edge not tight");

      let dualSum = 0;
      for (let i = 0; i < n; i++) dualSum += dual.u[i] + dual.v[i];
      if (Math.abs(dualSum - cost) <= EPS)
        checks.push(`strong duality: sum(u)+sum(v) = ${dualSum} = primal cost`);
      else errors.push(`dual objective ${dualSum} != primal cost ${cost}`);
    }
  } else {
    const { orders, neighborhood } = result.hallWitness;
    const orderSet = new Set(orders);
    const recomputedN = new Set<number>();
    for (const i of orders) {
      if (!Number.isInteger(i) || i < 0 || i >= n) errors.push(`witness order index ${i} out of range`);
      for (let j = 0; j < n; j++) if (problem.allowed[i][j]) recomputedN.add(j);
    }
    const claimedN = new Set(neighborhood);
    let same = recomputedN.size === claimedN.size;
    for (const j of recomputedN) if (!claimedN.has(j)) same = false;
    if (same) checks.push(`witness neighborhood consistent: N(S) has ${recomputedN.size} stations`);
    else errors.push("claimed neighborhood != recomputed neighborhood");

    if (orderSet.size > recomputedN.size)
      checks.push(`Hall violated: |S|=${orderSet.size} > |N(S)|=${recomputedN.size} => no perfect matching`);
    else errors.push(`Hall NOT violated: |S|=${orderSet.size} <= |N(S)|=${recomputedN.size}`);
  }

  return { ok: errors.length === 0, checks, errors };
}
