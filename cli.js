#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { validateModel, ValidationError } = require('./src/model');
const { solve } = require('./src/solver');

const EXIT = { optimal: 0, infeasible: 1, invalid: 2, unknown: 3 };

function usage() {
  return 'usage: shed <model.json> --gap <kW> [--budget <branches>]';
}

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { modelPath: null, gap: null, budget: Infinity };
  const bad = (message) => { throw new UsageError(message); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--gap') {
      i += 1;
      if (i >= argv.length) bad('--gap requires a value');
      args.gap = Number(argv[i]);
      if (!Number.isFinite(args.gap) || args.gap < 0) bad(`invalid --gap "${argv[i]}"`);
    } else if (arg === '--budget') {
      i += 1;
      if (i >= argv.length) bad('--budget requires a value');
      args.budget = Number(argv[i]);
      if (!Number.isInteger(args.budget) || args.budget < 1) bad(`invalid --budget "${argv[i]}"`);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--')) {
      bad(`unknown option "${arg}"`);
    } else if (args.modelPath === null) {
      args.modelPath = arg;
    } else {
      bad(`unexpected argument "${arg}"`);
    }
  }
  return args;
}

// Runs the CLI and returns the exit code. Output goes through `io` so tests
// can capture it in-process.
function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`shed: ${err.message}\n`);
      return EXIT.invalid;
    }
    throw err;
  }
  if (args.help) {
    io.stdout(`${usage()}\n`);
    return 0;
  }
  if (args.modelPath === null) {
    io.stderr(`shed: missing model file\n${usage()}\n`);
    return EXIT.invalid;
  }
  if (args.gap === null) {
    io.stderr('shed: missing required --gap <kW>\n');
    return EXIT.invalid;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(args.modelPath, 'utf8'));
  } catch (err) {
    io.stderr(`shed: cannot read model: ${err.message}\n`);
    return EXIT.invalid;
  }

  let model;
  try {
    model = validateModel(raw);
  } catch (err) {
    if (err instanceof ValidationError) {
      io.stderr(`shed: invalid model: ${err.message}\n`);
      return EXIT.invalid;
    }
    throw err;
  }

  const result = solve(model, { gap: args.gap, budget: args.budget });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return EXIT[result.status];
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, EXIT };
