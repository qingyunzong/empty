#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Scheduler } from './scheduler.js';
import { verifyEvents, enumerateTimings } from './verify.js';

const USAGE = [
  'usage: rework-router <run|verify> <input.json>',
  '  run     schedule the orders and print routes, deductions, preemptions, rollbacks',
  '  verify  exhaustively check all arrival permutations (requires <= 4 orders)',
].join('\n');

/**
 * Programmatic CLI entry. Returns { code, stdout?, stderr? } so it can be
 * driven both from the shell wrapper below and from tests in-process.
 */
export function main(argv) {
  const [, , command, file] = argv;
  if (!command || !file) return { code: 2, stderr: USAGE };

  let input;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { code: 2, stderr: `rework-router: cannot read input: ${err.message}` };
  }

  if (command === 'run') {
    let scheduler;
    try {
      scheduler = new Scheduler(input);
    } catch (err) {
      return { code: 2, stderr: `rework-router: invalid config: ${err.message}` };
    }
    const orders = input.orders ?? [];
    for (const order of orders) scheduler.addOrder(order);
    scheduler.run();
    for (let i = 0; i < (input.extraShifts ?? 0); i++) scheduler.advanceShift();
    const result = scheduler.getResult();
    const verification = verifyEvents(input, result.events, orders);
    return {
      code: verification.ok ? 0 : 1,
      stdout: JSON.stringify({ ...result, verification }, null, 2),
    };
  }

  if (command === 'verify') {
    let report;
    try {
      report = enumerateTimings(input, input.orders ?? []);
    } catch (err) {
      return { code: 2, stderr: `rework-router: ${err.message}` };
    }
    return { code: report.ok ? 0 : 1, stdout: JSON.stringify(report, null, 2) };
  }

  return { code: 2, stderr: USAGE };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const { code, stdout, stderr } = main(process.argv);
  if (stdout) process.stdout.write(`${stdout}\n`);
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exit(code);
}
