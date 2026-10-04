import { examples } from './examples.js';
import { run, formatTrace } from './simulator.js';

for (const example of examples) {
  console.log(`=== ${example.name} ===`);
  console.log(example.note);
  console.log(formatTrace(run(example.program, { maxSteps: example.maxSteps })));
  console.log();
}
