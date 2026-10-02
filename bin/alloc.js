#!/usr/bin/env node
'use strict';

const { loadState } = require('../src/store');
const { allocateOrder } = require('../src/allocator');

const EXIT = {
  OK: 0,             // allocated and persisted
  INFEASIBLE: 1,     // constraint conflict: order vs batches
  UNKNOWN: 2,        // search budget exhausted
  PERSIST_FAILED: 3, // failed before atomic rename; state.json untouched
  USAGE: 64,
};

function parseArgs(argv) {
  const args = { budget: undefined, failBeforeRename: false };
  const rest = [...argv];
  args.command = rest.shift();
  while (rest.length) {
    const flag = rest.shift();
    switch (flag) {
      case '--state': args.stateFile = rest.shift(); break;
      case '--order': args.orderFile = rest.shift(); break;
      case '--budget': args.budget = Number(rest.shift()); break;
      case '--fail-before-rename': args.failBeforeRename = true; break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/**
 * Runs the CLI. `io.out` / `io.err` receive line-oriented output; returns
 * the process exit code. Exported for in-process testing.
 */
function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(err.message);
    return EXIT.USAGE;
  }
  if (args.command !== 'allocate' || !args.stateFile || !args.orderFile) {
    io.err('usage: alloc allocate --state state.json --order order.json [--budget N] [--fail-before-rename]');
    return EXIT.USAGE;
  }

  const state = loadState(args.stateFile);
  const order = loadState(args.orderFile);

  const { status, result, rolledBack } = allocateOrder(state, order, {
    budget: args.budget,
    persist: true,
    stateFile: args.stateFile,
    failBeforeRename: args.failBeforeRename,
  });

  if (status === 'optimal') {
    const { status: _s, nodes: _n, ...rest } = result;
    io.out(JSON.stringify({ status, orderId: order.id, ...rest }, null, 2));
    return EXIT.OK;
  }
  if (status === 'infeasible') {
    io.out(JSON.stringify({ status, orderId: order.id, conflicts: result.conflicts }, null, 2));
    return EXIT.INFEASIBLE;
  }
  if (status === 'unknown') {
    io.out(JSON.stringify({ status, orderId: order.id, reason: result.reason, nodes: result.nodes }, null, 2));
    return EXIT.UNKNOWN;
  }
  // persist-failed: original state.json preserved, in-memory allocation rolled back
  io.err(JSON.stringify({ status, orderId: order.id, error: result.error, rolledBack }));
  return EXIT.PERSIST_FAILED;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, EXIT };
