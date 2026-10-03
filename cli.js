#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InvalidCommand } from './src/ledger.js';
import { shrinkPlan } from './src/shrink.js';

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [, , command, planPath] = argv;
  if (command !== 'shrink' || planPath === undefined) {
    io.stderr.write('USAGE: node cli.js shrink <plan.json>\n');
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    io.stderr.write(`INVALID_PLAN: ${err.message}\n`);
    return 2;
  }
  try {
    const result = shrinkPlan(plan);
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InvalidCommand || err?.code === 'INVALID_COMMAND') {
      io.stderr.write(`INVALID_COMMAND: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  process.exit(run(process.argv));
}
