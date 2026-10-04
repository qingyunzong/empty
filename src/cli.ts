/**
 * CLI：node dist/src/cli.js <input.json> [--check] [--brute]
 * 退出码：0 = 最优解；3 = 不可行（已给出 Hall 见证）；1 = 输入/运行错误。
 */
import { readFileSync } from "node:fs";
import { parseProblem } from "./parse.js";
import { solve, type Problem } from "./solver.js";
import { verifySolution } from "./verify.js";
import { bruteForcePermutation, dpSolve } from "./brute.js";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const wantCheck = args.includes("--check");
  const wantBrute = args.includes("--brute");
  if (!file) {
    console.error("usage: assign <input.json> [--check] [--brute]");
    return 1;
  }

  let problem: Problem;
  try {
    problem = parseProblem(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: String((err as Error).message) }, null, 2));
    return 1;
  }

  const result = solve(problem);
  const report = verifySolution(problem, result);
  const n = problem.orderIds.length;

  const output: Record<string, unknown> = { status: result.status };
  if (result.status === "optimal") {
    output.cost = result.cost;
    output.matching = result.match.map((j, i) => ({
      order: problem.orderIds[i],
      station: problem.stationIds[j],
      cost: problem.cost[i][j],
    }));
    output.dualCertificate = {
      u: Object.fromEntries(problem.orderIds.map((id, i) => [id, result.dual.u[i]])),
      v: Object.fromEntries(problem.stationIds.map((id, j) => [id, result.dual.v[j]])),
    };
  } else {
    output.hallWitness = {
      orders: result.hallWitness.orders.map((i) => problem.orderIds[i]),
      neighborhood: result.hallWitness.neighborhood.map((j) => problem.stationIds[j]),
      violation: `|S|=${result.hallWitness.orders.length} > |N(S)|=${result.hallWitness.neighborhood.length}`,
    };
  }
  output.verification = report;

  if (wantCheck) {
    const dp = dpSolve(problem);
    const cross: Record<string, unknown> = {
      dp: { feasible: dp.feasible, cost: dp.feasible ? dp.cost : null },
    };
    if (wantBrute) {
      if (n > 10) {
        cross.bruteForce = { skipped: `n=${n} too large for permutation enumeration (limit 10)` };
      } else {
        const bf = bruteForcePermutation(problem);
        cross.bruteForce = { feasible: bf.feasible, cost: bf.feasible ? bf.cost : null };
      }
    }
    const expectedFeasible = result.status === "optimal";
    const dpAgrees =
      dp.feasible === expectedFeasible &&
      (!dp.feasible || Math.abs(dp.cost - (result.status === "optimal" ? result.cost : NaN)) < 1e-9);
    cross.dpAgrees = dpAgrees;
    output.crossCheck = cross;
  }

  console.log(JSON.stringify(output, null, 2));
  if (!report.ok) return 1;
  return result.status === "optimal" ? 0 : 3;
}

process.exitCode = main(process.argv);
