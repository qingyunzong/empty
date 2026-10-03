#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Store } from './src/store.js';
import { SchedError } from './src/errors.js';
import { scheduleBatch, scheduleJoint, enumerateJointPlans } from './src/scheduler.js';

function fail(code, message, exitCode, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  process.exit(exitCode);
}

function readInput(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return readFileSync(0, 'utf8'); // stdin
  if (args.length === 2 && args[0] === '--file') return readFileSync(args[1], 'utf8');
  fail('E_USAGE', 'usage: node cli.js [--file script.json] < script.json', 2);
}

let script;
try {
  script = JSON.parse(readInput(process.argv));
} catch (err) {
  fail('E_PARSE', `invalid JSON input: ${err.message}`, 2);
}

try {
  const store = new Store();
  for (const b of script.budgets ?? []) store.setBudget(b.material, b.day, b.amount);
  const orders = script.orders ?? [];
  const mode = script.mode ?? 'batch';

  let out;
  if (mode === 'batch') {
    out = { ok: true, mode, ...scheduleBatch(store, orders) };
  } else if (mode === 'joint') {
    out = { ok: true, mode, ...scheduleJoint(store, orders, script.budgets ?? []) };
  } else if (mode === 'enumerate') {
    out = { ok: true, mode, assignments: enumerateJointPlans(orders, script.budgets ?? []) };
  } else {
    fail('E_USAGE', `unknown mode: ${mode}`, 2);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (err) {
  if (err instanceof SchedError) fail(err.code, err.message, 1, err.details);
  throw err;
}
