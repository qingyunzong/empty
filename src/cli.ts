import { readFileSync } from 'node:fs';
import { Instruction, Simulator } from './simulator';
import { enumerateSchedules } from './exhaustive';
import { runSequential, verifySequential } from './sequential';

interface Scenario {
  shared?: Record<string, number>;
  threads: Instruction[][];
  schedule?: number[];
  maxSteps?: number;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node dist/src/cli.js <scenario.json>');
    process.exitCode = 1;
    return;
  }
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  const shared = scenario.shared ?? {};

  if (scenario.schedule) {
    const sim = new Simulator(scenario.threads, shared);
    console.log(`initial: ${JSON.stringify(sim.result())}`);
    scenario.schedule.forEach((t, i) => {
      sim.step(t);
      console.log(`step ${i + 1}: run T${t} -> ${JSON.stringify(sim.result())}`);
    });
    console.log(`final (${scenario.schedule.length} steps): ${JSON.stringify(sim.result())}`);
  }

  const maxSteps = scenario.maxSteps ?? 20;
  const report = enumerateSchedules(scenario.threads, shared, maxSteps);
  console.log(
    `exhaustive (<= ${maxSteps} steps): ${report.exploredStates} states, ${report.results.size} distinct results`,
  );
  for (const result of report.results.values()) {
    console.log(`  ${JSON.stringify(result)}`);
  }

  const sequential = runSequential(scenario.threads, shared);
  const verification = verifySequential(scenario.threads, shared, maxSteps);
  console.log(`sequential reference: ${JSON.stringify(sequential)}`);
  console.log(
    `sequential result ${verification.contained ? 'IS' : 'is NOT'} contained in the exhaustive result set`,
  );
}

main();
