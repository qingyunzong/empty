#!/usr/bin/env node
'use strict';
const { readFileSync } = require('node:fs');
const { validatePlan, PlanError } = require('./plan');
const { explore } = require('./explore');

function invalidPlan(details) {
  if (details) process.stderr.write(`INVALID_PLAN: ${details}\n`);
  process.stdout.write(JSON.stringify({ error: 'INVALID_PLAN' }) + '\n');
  return 1;
}

function main(argv) {
  const [command, file] = argv;
  if (command !== 'explore' || !file || argv.length !== 2) {
    process.stderr.write('usage: node src/cli.js explore <plan.json>\n');
    return 2;
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read plan file: ${err.message}\n`);
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (err) {
    return invalidPlan(`invalid JSON: ${err.message}`);
  }
  let norm;
  try {
    norm = validatePlan(plan);
  } catch (err) {
    if (err instanceof PlanError) return invalidPlan(err.message);
    throw err;
  }
  const result = explore(norm);
  const output = {
    reachable: result.reachable,
    violating: result.violating,
    counterexample: result.counterexample,
    certificate: result.certificate,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
