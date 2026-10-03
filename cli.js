#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Simulator } = require('./src/simulator');

function usage() {
  console.error('usage: node cli.js sim --in <dir> --out <dir>');
  process.exit(1);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'sim') usage();
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { in: { type: 'string' }, out: { type: 'string' } },
    }));
  } catch {
    usage();
  }
  if (!values.in || !values.out) usage();

  const tasks = JSON.parse(fs.readFileSync(path.join(values.in, 'tasks.json'), 'utf8'));
  const lines = fs
    .readFileSync(path.join(values.in, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');

  const sim = new Simulator(tasks);
  lines.forEach((line, index) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (err) {
      sim.fail({ line: index + 1, raw: line }, 'BAD_EVENT', `invalid JSON: ${err.message}`);
      return;
    }
    sim.applyEvent(ev);
  });

  fs.mkdirSync(values.out, { recursive: true });
  fs.writeFileSync(
    path.join(values.out, 'final_slots.json'),
    JSON.stringify(sim.finalSlots(), null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(values.out, 'ledger.jsonl'),
    sim.ledger.map((e) => JSON.stringify(e)).join('\n') + (sim.ledger.length ? '\n' : '')
  );
  fs.writeFileSync(
    path.join(values.out, 'errors.jsonl'),
    sim.errors.map((e) => JSON.stringify(e)).join('\n') + (sim.errors.length ? '\n' : '')
  );

  if (sim.errors.length > 0) {
    process.exitCode = 2;
  }
}

main(process.argv.slice(2));
