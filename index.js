#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { solve, InputError } = require('./lib/solver');

function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'audit' || !inputPath || !outputPath) {
    io.stderr.write('usage: node . audit <input.json> <output.json>\n');
    return 2;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    io.stderr.write(`INPUT_ERROR: cannot read/parse ${inputPath}: ${err.message}\n`);
    return 1;
  }
  let result;
  try {
    result = solve(input);
  } catch (err) {
    if (err instanceof InputError) {
      io.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  io.stdout.write(`${result.status} -> ${outputPath}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
