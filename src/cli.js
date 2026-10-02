#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { normalize, ValidationError } = require('./model');
const { solve } = require('./solver');

const USAGE = 'usage: node src/cli.js schedule <input.json> [--budget N]';

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'schedule') {
    fail(USAGE);
  }
  const inputPath = args[1];
  if (!inputPath) {
    fail(`missing input file\n${USAGE}`);
  }
  let budget = 10000;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--budget') {
      const value = Number(args[i + 1]);
      if (args[i + 1] === undefined || !Number.isInteger(value) || value < 0) {
        fail('--budget must be a non-negative integer');
      }
      budget = value;
      i += 1;
    } else {
      fail(`unknown argument: ${args[i]}\n${USAGE}`);
    }
  }

  let text;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    fail(`cannot read input file ${inputPath}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(`invalid JSON in ${inputPath}: ${e.message}`);
  }
  let model;
  try {
    model = normalize(data);
  } catch (e) {
    if (e instanceof ValidationError) fail(e.message);
    throw e;
  }

  const result = solve(model, { budget });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv);
