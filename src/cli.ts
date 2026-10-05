#!/usr/bin/env node
/**
 * CLI: node dist/src/cli.js <instance.json> [--verify]
 * Prints the optimal schedule and the per-tick heat trajectory.
 * With --verify (default on) it cross-checks the makespan against the
 * exhaustive per-tick BFS and replays the schedule with the simulator.
 */
import { readFileSync } from "node:fs";
import { Instance, validateInstance, Solution } from "./model";
import { solve } from "./solve";
import { bruteForceMakespan } from "./brute";
import { simulate } from "./simulate";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const verify = !args.includes("--no-verify");
  if (!file) {
    console.error("usage: cli <instance.json> [--verify|--no-verify]");
    return 2;
  }

  const inst = JSON.parse(readFileSync(file, "utf8")) as Instance;
  validateInstance(inst);

  const sol: Solution = solve(inst);
  if (!sol.feasible) {
    console.log(`INFEASIBLE within ${inst.maxTicks} ticks`);
    if (verify) {
      const bf = bruteForceMakespan(inst);
      console.log(
        bf === -1
          ? "verify: exhaustive per-tick BFS agrees (infeasible)"
          : `verify: MISMATCH, BFS found makespan ${bf}`,
      );
      return bf === -1 ? 1 : 3;
    }
    return 1;
  }

  console.log(`makespan: ${sol.makespan} ticks`);
  console.log("schedule:");
  for (const e of sol.schedule) {
    console.log(`  ${e.taskId}: ticks ${e.start}..${e.end}`);
  }
  console.log("heat trajectory (tick: action -> heat):");
  for (const tr of sol.trace) {
    console.log(`  t=${String(tr.tick).padStart(2)}  ${tr.action.padEnd(8)} -> ${tr.heatAfter}`);
  }

  if (verify) {
    const sim = simulate(inst, sol.schedule);
    const bf = bruteForceMakespan(inst);
    const simOk = sim.ok && sim.makespan === sol.makespan;
    const bfOk = bf === sol.makespan;
    console.log(
      `verify: simulator ${simOk ? "OK" : "FAIL " + sim.errors.join("; ")}` +
        ` | exhaustive BFS ${bfOk ? "OK" : `MISMATCH (got ${bf})`}`,
    );
    if (!simOk || !bfOk) return 3;
  }
  return 0;
}

process.exit(main(process.argv));
