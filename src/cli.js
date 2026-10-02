'use strict';

const { readFileSync } = require('node:fs');
const { BudgetError } = require('./tree');
const { explore } = require('./enumerator');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const error = new Error(`cannot read ${path}: ${err.message}`);
    error.exitCode = 2;
    throw error;
  }
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.length !== 2) {
    io.stderr.write('usage: explree <tree.json> <actors.json>\n');
    return 2;
  }
  let result;
  try {
    const treeSpec = readJson(argv[0]);
    const actorsSpec = readJson(argv[1]);
    const actors = Array.isArray(actorsSpec) ? actorsSpec : actorsSpec.actors;
    result = explore(treeSpec, actors);
  } catch (err) {
    if (err instanceof BudgetError) {
      io.stderr.write(`${JSON.stringify({ status: 'ERROR', code: err.code, message: err.message })}\n`);
      return 2;
    }
    io.stderr.write(`${JSON.stringify({ status: 'ERROR', message: err.message })}\n`);
    return err.exitCode ?? 2;
  }
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'SAFE' ? 0 : 1;
}

module.exports = { main };
