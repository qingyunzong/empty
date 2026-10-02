#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { solve } = require('./src/solver');
const { validate } = require('./src/validate');

const EXIT = { optimal: 0, infeasible: 1, invalid: 2, unknown: 3 };

function fail(message) {
  process.stderr.write(`plan: ${message}\n`);
  process.exit(EXIT.invalid);
}

function main(argv) {
  const args = argv.slice(2);
  let inputPath = null;
  let budget = 1000;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--budget') {
      i += 1;
      if (i >= args.length || !/^\d+$/.test(args[i])) {
        fail('--budget requires a non-negative integer');
      }
      budget = Number(args[i]);
    } else if (a.startsWith('--budget=')) {
      const v = a.slice('--budget='.length);
      if (!/^\d+$/.test(v)) fail('--budget requires a non-negative integer');
      budget = Number(v);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: plan input.json [--budget N]\n');
      process.exit(0);
    } else if (inputPath === null) {
      inputPath = a;
    } else {
      fail(`unexpected argument: ${a}`);
    }
  }
  if (!inputPath) fail('usage: plan input.json [--budget N]');

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    fail(`cannot read ${inputPath}: ${e.message}`);
  }
  let model;
  try {
    model = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in ${inputPath}: ${e.message}`);
  }

  const errors = validate(model);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`plan: invalid input: ${e}\n`);
    process.exit(EXIT.invalid);
  }

  const result = solve(model, { budget });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(EXIT[result.status]);
}

main(process.argv);
