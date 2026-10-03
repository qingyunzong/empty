#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  EXIT,
  OrderError,
  MergeConflict,
  diffOrders,
  applyPatch,
  undoPatch,
  redoPatch,
  mergeOrders,
} = require('./lib/orders');

const USAGE = `usage:
  node index.js merge-orders --base base.json --local local.json --remote remote.json [--out merged.json]
  node index.js diff --base base.json --target target.json [--out patch.json]
  node index.js apply --orders orders.json --patch patch.json [--out result.json]
  node index.js undo --orders orders.json --patch patch.json [--out result.json]
  node index.js redo --orders orders.json --patch patch.json [--out result.json]

exit codes: 0 success, 1 merge conflict, 2 unknown order or illegal patch`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      throw new OrderError(EXIT.INVALID, `unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new OrderError(EXIT.INVALID, `missing value for --${key}`);
    }
    opts[key] = value;
    i += 1;
  }
  return { command, opts };
}

function requireOpt(opts, name) {
  if (opts[name] === undefined) {
    throw new OrderError(EXIT.INVALID, `missing required option --${name}`);
  }
  return opts[name];
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new OrderError(EXIT.INVALID, `cannot read ${label} (${file}): ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OrderError(EXIT.INVALID, `invalid JSON in ${label} (${file}): ${err.message}`);
  }
}

function emit(opts, io, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (opts.out) {
    fs.writeFileSync(opts.out, text);
  } else {
    io.stdout(text);
  }
}

function dispatch(command, opts, io) {
  switch (command) {
    case 'merge-orders': {
      const base = readJson(requireOpt(opts, 'base'), 'base');
      const local = readJson(requireOpt(opts, 'local'), 'local');
      const remote = readJson(requireOpt(opts, 'remote'), 'remote');
      emit(opts, io, mergeOrders(base, local, remote));
      return EXIT.OK;
    }
    case 'diff': {
      const base = readJson(requireOpt(opts, 'base'), 'base');
      const target = readJson(requireOpt(opts, 'target'), 'target');
      emit(opts, io, diffOrders(base, target));
      return EXIT.OK;
    }
    case 'apply':
    case 'undo':
    case 'redo': {
      const orders = readJson(requireOpt(opts, 'orders'), 'orders');
      const patch = readJson(requireOpt(opts, 'patch'), 'patch');
      const fn = { apply: applyPatch, undo: undoPatch, redo: redoPatch }[command];
      emit(opts, io, fn(orders, patch));
      return EXIT.OK;
    }
    case undefined:
    case 'help':
    case '--help':
      io.stdout(`${USAGE}\n`);
      return EXIT.OK;
    default:
      throw new OrderError(EXIT.INVALID, `unknown command: ${command}\n${USAGE}`);
  }
}

function runCli(argv, io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text));
  const err = io.stderr || ((text) => process.stderr.write(text));
  const streams = { stdout: out, stderr: err };
  try {
    const { command, opts } = parseArgs(argv);
    return dispatch(command, opts, streams);
  } catch (error) {
    if (error instanceof MergeConflict) {
      err(`conflict: ${error.message}\n`);
      for (const conflict of error.conflicts) {
        err(`  ${JSON.stringify(conflict)}\n`);
      }
      return EXIT.CONFLICT;
    }
    if (error instanceof OrderError) {
      err(`error: ${error.message}\n`);
      return error.exitCode;
    }
    err(`${(error && error.stack) || error}\n`);
    return EXIT.INVALID;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

module.exports = { runCli, USAGE };
