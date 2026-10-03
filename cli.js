#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Planner } from './src/planner.js';
import { CODES, PlanError } from './src/errors.js';

function dispatch(planner, cmd) {
  switch (cmd?.op) {
    case 'addOrder':
      return planner.addOrder(cmd.order);
    case 'addOrders': {
      const orders = cmd.orders ?? [];
      for (const order of orders) planner.addOrder(order);
      return { ok: true, count: orders.length };
    }
    case 'schedule':
      return planner.schedule();
    case 'insertRush':
      return planner.insertRush(cmd.order, { budget: cmd.budget });
    case 'beginGroup':
      planner.beginGroup(cmd.label);
      return { ok: true };
    case 'commitGroup':
      return planner.commitGroup();
    case 'undo':
      return planner.undo();
    case 'redo':
      return planner.redo();
    default:
      throw new PlanError(CODES.VALIDATION, `unknown command op: ${JSON.stringify(cmd?.op)}`);
  }
}

export function runJob(input) {
  const planner = new Planner({
    calendar: input.calendar,
    machines: input.machines,
    nodeCap: input.options?.nodeCap,
  });
  const commands = input.commands ?? [
    ...(input.orders ?? []).map((order) => ({ op: 'addOrder', order })),
    { op: 'schedule' },
  ];
  const results = [];
  for (const cmd of commands) {
    const result = dispatch(planner, cmd);
    results.push({ command: cmd.op, ...result });
    if (result.ok === false) {
      return { ok: false, results, error: result };
    }
  }
  return { ok: true, results, plan: planner.planJson() };
}

function readInput() {
  const arg = process.argv[2];
  if (arg && arg !== '-') return readFileSync(arg, 'utf8');
  return readFileSync(0, 'utf8');
}

function main() {
  let out;
  try {
    out = runJob(JSON.parse(readInput()));
  } catch (e) {
    if (e instanceof PlanError) {
      out = { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    } else if (e instanceof SyntaxError) {
      out = { ok: false, error: { code: CODES.VALIDATION, message: `invalid JSON input: ${e.message}` } };
    } else {
      throw e;
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = out.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
