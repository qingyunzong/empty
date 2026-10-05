/**
 * Thermal-aware scheduler CLI.
 *
 * Usage:
 *   node dist/src/cli.js <problem.json> [--json]
 *
 * Prints the minimal makespan, the per-task schedule, the per-tick heat
 * trajectory, and the result of an independent exhaustive per-tick search
 * used to cross-check the optimum.
 */

import { readFileSync } from "node:fs";
import { parseProblem } from "./model.js";
import { solve } from "./solver.js";
import { verifyExhaustive } from "./verifier.js";
import { simulate } from "./simulate.js";

function main(argv: string[]): void {
  const args = argv.slice(2);
  const jsonFlag = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (file === undefined) {
    console.error("usage: node dist/src/cli.js <problem.json> [--json]");
    process.exitCode = 2;
    return;
  }

  const problem = parseProblem(readFileSync(file, "utf8"));
  const result = solve(problem);
  const check = verifyExhaustive(problem);
  const agree = result.feasible === check.feasible &&
    (!result.feasible || result.makespan === check.makespan);
  const sim = result.feasible ? simulate(problem, result.runs) : null;

  if (jsonFlag) {
    console.log(JSON.stringify({
      makespan: result.makespan,
      feasible: result.feasible,
      runs: result.runs,
      trajectory: result.trajectory,
      verification: {
        exhaustiveMakespan: check.makespan,
        agree,
        trajectoryValid: sim === null ? null : sim.ok,
        trajectoryErrors: sim === null ? [] : sim.errors,
      },
    }, null, 2));
    if (!agree || (sim !== null && !sim.ok)) process.exitCode = 1;
    return;
  }

  console.log(`tasks=${problem.tasks.length} maxTemp=${problem.maxTemp} ` +
    `cooling=${problem.coolingRate} horizon=${problem.maxTicks}`);
  if (!result.feasible) {
    console.log(`INFEASIBLE within ${problem.maxTicks} ticks ` +
      `(explored ${result.statesExplored} states)`);
  } else {
    console.log(`optimal makespan: ${result.makespan} ticks ` +
      `(explored ${result.statesExplored} states)`);
    console.log("schedule:");
    for (const r of result.runs) {
      console.log(`  ${r.id}: ticks ${r.start + 1}..${r.end}`);
    }
    console.log("heat trajectory (tick: action -> temp):");
    const parts = result.trajectory.map((a) => `${a.tick}:${a.action}->${a.temp}`);
    for (let i = 0; i < parts.length; i += 6) {
      console.log("  " + parts.slice(i, i + 6).join("  "));
    }
  }
  console.log(`exhaustive per-tick search: makespan=${check.makespan} ` +
    `(explored ${check.statesExplored} states)`);
  console.log(`cross-check: ${agree ? "AGREE" : "DISAGREE"}`);
  if (sim !== null) {
    console.log(`trajectory validation: ${sim.ok ? "OK" : "FAILED: " + sim.errors.join("; ")}`);
  }
  if (!agree || (sim !== null && !sim.ok)) process.exitCode = 1;
}

main(process.argv);
