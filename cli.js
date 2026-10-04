#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { ToolLifeService, MonotonicityError } = require('./src/service');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_BUDGET = 5;
const EXIT_MONOTONIC = 11;

function parseArgs(argv) {
  const opts = { limit: 80, maxBudget: 3, window: Infinity, opsFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      opts.limit = Number(argv[++i]);
    } else if (arg === '--max') {
      opts.maxBudget = Number(argv[++i]);
    } else if (arg === '--window') {
      opts.window = Number(argv[++i]);
    } else if (!arg.startsWith('--') && opts.opsFile === null) {
      opts.opsFile = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.opsFile === null) {
    throw new Error('usage: node cli.js ops.json --limit 80 --max 3 [--window N]');
  }
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
    throw new Error(`invalid --limit: ${opts.limit}`);
  }
  if (!Number.isInteger(opts.maxBudget) || opts.maxBudget < 0) {
    throw new Error(`invalid --max: ${opts.maxBudget}`);
  }
  if (!(opts.window === Infinity) && !(Number.isFinite(opts.window) && opts.window >= 0)) {
    throw new Error(`invalid --window: ${opts.window}`);
  }
  return opts;
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return EXIT_USAGE;
  }

  let ops;
  try {
    ops = JSON.parse(fs.readFileSync(opts.opsFile, 'utf8'));
  } catch (err) {
    io.stderr.write(`cannot read ops file ${opts.opsFile}: ${err.message}\n`);
    return EXIT_USAGE;
  }
  if (!Array.isArray(ops)) {
    io.stderr.write('ops file must contain a JSON array of operations\n');
    return EXIT_USAGE;
  }

  const service = new ToolLifeService({
    limit: opts.limit,
    maxBudget: opts.maxBudget,
    window: opts.window,
  });

  try {
    service.applyAll(ops);
  } catch (err) {
    if (err instanceof MonotonicityError) {
      io.stderr.write(`monotonicity violation: ${err.message}\n`);
      io.stdout.write(`${JSON.stringify(service.report(), null, 2)}\n`);
      return EXIT_MONOTONIC;
    }
    throw err;
  }

  io.stdout.write(`${JSON.stringify(service.report(), null, 2)}\n`);

  if (service.rejections.some((r) => r.code === 'BUDGET_EXCEEDED')) {
    return EXIT_BUDGET;
  }
  return EXIT_OK;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, EXIT_OK, EXIT_USAGE, EXIT_BUDGET, EXIT_MONOTONIC };
