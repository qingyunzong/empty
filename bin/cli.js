#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { allocateOrder } from '../src/allocate.js';
import { CommitError, commitState, loadState } from '../src/store.js';

export const EXIT = {
  OK: 0,
  USAGE: 1,
  INFEASIBLE: 2,
  COMMIT_FAILED: 3,
  UNKNOWN: 4,
};

const USAGE = `Usage:
  cli.js init --state <path>
  cli.js allocate --state <path> (--order <json> | --order-file <path>)
                  [--budget <n>] [--fail-before-rename]

Exit codes: 0 allocated, 1 usage/io error, 2 infeasible, 3 commit failed
(original state.json preserved, safe to retry), 4 unknown (budget exhausted).`;

function parseOrder(values) {
  if (values.order && values['order-file']) throw new Error('use --order or --order-file, not both');
  if (values['order-file']) return JSON.parse(readFileSync(values['order-file'], 'utf8'));
  if (values.order) return JSON.parse(values.order);
  throw new Error('an order is required via --order <json> or --order-file <path>');
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: 'string' },
      order: { type: 'string' },
      'order-file': { type: 'string' },
      budget: { type: 'string' },
      'fail-before-rename': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (!values.state) throw new Error('--state <path> is required');

  if (command === 'init') {
    if (existsSync(values.state)) throw new Error(`state file already exists: ${values.state}`);
    commitState({ batches: [], orders: [], allocations: [] }, values.state);
    io.stdout.write(`initialized ${values.state}\n`);
    return EXIT.OK;
  }

  if (command !== 'allocate') throw new Error(`unknown command: ${command ?? '(none)'}`);

  const order = parseOrder(values);
  const budget = values.budget === undefined ? undefined : Number.parseInt(values.budget, 10);
  if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0)) {
    throw new Error('--budget must be a positive integer');
  }

  const state = loadState(values.state);
  const result = allocateOrder(state, order, budget === undefined ? {} : { budget });

  if (result.status === 'infeasible') {
    io.stdout.write(`${JSON.stringify({ status: 'infeasible', orderId: order.id, conflicts: result.conflicts })}\n`);
    return EXIT.INFEASIBLE;
  }
  if (result.status === 'unknown') {
    io.stdout.write(`${JSON.stringify({ status: 'unknown', orderId: order.id, nodes: result.nodes })}\n`);
    return EXIT.UNKNOWN;
  }

  // Optimal allocation found; commit is the transaction boundary. If the
  // commit fails, result.state is discarded and the on-disk state is the
  // untouched original, so the allocation is fully rolled back.
  commitState(result.state, values.state, { failBeforeRename: values['fail-before-rename'] });
  io.stdout.write(`${JSON.stringify({
    status: 'allocated',
    orderId: order.id,
    allocation: result.allocation,
    transferCost: result.transferCost,
    maxRemainingDays: result.maxRemainingDays,
  })}\n`);
  return EXIT.OK;
}

export function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    return main(argv, io);
  } catch (err) {
    if (err instanceof CommitError) {
      io.stderr.write(`commit failed: ${err.message}\nstate file left unchanged; in-memory allocation rolled back; retry the command\n`);
      return EXIT.COMMIT_FAILED;
    }
    io.stderr.write(`error: ${err.message}\n${USAGE}\n`);
    return EXIT.USAGE;
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  process.exitCode = run(process.argv.slice(2));
}
