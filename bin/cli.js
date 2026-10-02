#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { LimitEngine } from '../src/engine.js';
import { scenarios } from '../src/scenarios.js';

const [, , cmd, arg] = process.argv;

process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const usage = `usage:
  node bin/cli.js run <script.json>     apply ops from file, print JSONL results
  node bin/cli.js scenario <1|2|3|4>    run a built-in acceptance scenario
  node bin/cli.js state <script.json>   print only the final normalized state`;

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (cmd === 'run' && arg) {
  const script = JSON.parse(readFileSync(arg, 'utf8'));
  const engine = new LimitEngine(script.config);
  for (const op of script.ops) {
    process.stdout.write(`${JSON.stringify(engine.apply(op))}\n`);
  }
} else if (cmd === 'state' && arg) {
  const script = JSON.parse(readFileSync(arg, 'utf8'));
  const engine = new LimitEngine(script.config);
  for (const op of script.ops) engine.apply(op);
  print(engine.state());
} else if (cmd === 'scenario' && scenarios[arg]) {
  print(scenarios[arg]());
} else {
  process.stderr.write(usage);
  process.exitCode = 1;
}
