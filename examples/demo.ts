// Demo: real check trace + resumable shrinking, printed to stdout.
import { check, integer, sortedArrayOf, arrayOf } from "../src";
import { shrink, resumeShrink, ShrinkCheckpoint } from "../src";

const line = (s: string) => process.stdout.write(s + "\n");

// 1. A falsified property with its actual check trace.
const arb = sortedArrayOf(integer(0, 20), { minLength: 1, maxLength: 8 });
const property = (v: number[]) => v.reduce((a, b) => a + b, 0) <= 10;
const report = check(arb, property, { seed: "demo-seed", numRuns: 200 });

line(`status:      ${report.status}`);
line(`seed:        ${report.seed}`);
line(`counterex.:  ${JSON.stringify(report.counterexample)}`);
line(`minimal:     ${JSON.stringify(report.minimal)}`);
line(`shrink steps: ${report.shrinkSteps}, shrink tests: ${report.shrinkTestsRun}`);
line("trace (first 12 entries):");
for (const e of report.trace.slice(0, 12)) {
  line(`  #${e.step} ${e.phase} ${e.outcome} ${JSON.stringify(e.value)}`);
}
line(`trace total: ${report.trace.length} entries`);

// 2. Resumable shrinking: stop early, persist checkpoint, resume.
const arr = arrayOf(integer(0, 100), { minLength: 0, maxLength: 10 });
const interesting = (v: number[]) => v.reduce((a, b) => a + b, 0) >= 30;
const part = shrink(arr, interesting, [10, 20, 30, 40, 50], { maxTests: 2 });
const saved: string = JSON.stringify(part.checkpoint);
line(`\ncheckpoint after ${part.testsRun} tests (complete=${part.complete}), ` +
  `${saved.length} bytes of JSON`);
const restored = JSON.parse(saved) as ShrinkCheckpoint<number[]>;
const resumed = resumeShrink(arr, interesting, restored);
line(`resumed: ${resumed.testsRun} more tests, minimal=${JSON.stringify(resumed.minimal)}`);
line(`single-step irreducible: ${resumed.complete}`);
