import { buildReport } from "./report.js";
import { runScenario } from "./scenario.js";

async function main(): Promise<void> {
  const seed = 42;
  console.log(`Out-of-order delivery simulation (seed=${seed})`);
  console.log("");
  const { runtime } = await runScenario(seed);
  console.log(buildReport(runtime));
}

void main();
