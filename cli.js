#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runScenario, ScenarioError } = require('./src/simulate');

function runCliFile(file) {
  if (!file) {
    return { code: 2, out: '', err: 'usage: node cli.js <scenario.json>' };
  }
  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { code: 2, out: '', err: 'protocol error: cannot read/parse scenario: ' + e.message };
  }
  let result;
  try {
    result = runScenario(scenario);
  } catch (e) {
    if (e instanceof ScenarioError) {
      return { code: 2, out: '', err: 'protocol error: ' + e.message };
    }
    throw e;
  }
  return { code: result.exitCode, out: JSON.stringify(result.output, null, 2) + '\n', err: '' };
}

function main() {
  const res = runCliFile(process.argv[2]);
  if (res.out) process.stdout.write(res.out);
  if (res.err) process.stderr.write(res.err + '\n');
  process.exit(res.code);
}

if (require.main === module) main();

module.exports = { runCliFile };
