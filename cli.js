#!/usr/bin/env node
'use strict';

// CLI: candidates | award | apply-change
//
//   node cli.js candidates   --data DIR --order ORDER_ID
//   node cli.js award        --data DIR --order ORDER_ID
//   node cli.js apply-change --data DIR --order ORDER_ID --event JSON [--event JSON ...]
//
// Data directory contains: orders.json, machines.json, costs.json, budget.json.

const fs = require('node:fs');
const path = require('node:path');
const { candidates, award, applyChange } = require('./src/lib');

function parseArgs(argv) {
  const args = { events: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--event') {
      args.events.push(JSON.parse(argv[i + 1]));
      i += 1;
    } else if (key.startsWith('--')) {
      args[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unexpected argument: ${key}`);
    }
  }
  return args;
}

function loadData(dir) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const budgetRaw = read('budget.json');
  return {
    orders: read('orders.json'),
    machines: read('machines.json'),
    costs: read('costs.json'),
    budget: typeof budgetRaw === 'number' ? budgetRaw : budgetRaw.budget,
  };
}

// Invoable in-process (tests) and from the command line. Returns the result
// object; throws on usage errors.
function run(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || !args.data || !args.order) {
    throw new Error('usage: node cli.js <candidates|award|apply-change> --data DIR --order ID [--event JSON ...]');
  }
  const data = loadData(args.data);
  if (command === 'candidates') return candidates(data, args.order);
  if (command === 'award') return award(data, args.order);
  if (command === 'apply-change') {
    if (args.events.length === 0) throw new Error('apply-change requires at least one --event JSON');
    return applyChange(data, args.order, args.events);
  }
  throw new Error(`unknown command: ${command}`);
}

function main() {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { run, parseArgs, loadData };
