import { solve } from "./solve.js";
import { checkSchedule } from "./schedule.js";
import { renderTimeline } from "./timeline.js";
import { demo } from "./demo.js";

const t0 = performance.now();
const solution = solve(demo);
const elapsed = performance.now() - t0;

if (!solution) {
  console.log(`No schedule fits the horizon of ${demo.horizon}.`);
} else {
  checkSchedule(demo, solution); // throws if invalid
  console.log(`Optimal makespan: ${solution.makespan} (horizon ${demo.horizon})`);
  console.log(`Search: ${solution.nodes} states expanded in ${elapsed.toFixed(1)} ms`);
  console.log("");
  console.log(renderTimeline(demo, solution));
  console.log("");
  console.log("Schedule (verified: deps, skills, worker exclusivity, both-sync):");
  for (const e of solution.entries) {
    const who = e.workers.length === 2 ? "W1+W2" : e.workers[0] === 0 ? "W1   " : "W2   ";
    console.log(`  ${e.id.padEnd(4)} [${String(e.start).padStart(2)}, ${String(e.end).padStart(2)})  on ${who}`);
  }
}
