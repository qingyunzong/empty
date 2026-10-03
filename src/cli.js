#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { buildReport } from './report.js';

function usage() {
  console.error(`usage: node src/cli.js [--naive] [--verify] [--compact] [input.json]

Reads a scenario from <input.json> or stdin:
  { "config": { "pool": N, "agingK": K, "preemptWindow": W, "cards": { "cardId": limit } },
    "events": [ { "slot": S, "type": "auth"|"capture"|"revoke", ... } ] }

Prints { timeline, violations, wakes, queue, certificates, ok } as JSON.`);
  process.exit(2);
}

const args = process.argv.slice(2);
let strategy = 'heap';
let verify = false;
let compact = false;
let file = null;
for (const arg of args) {
  if (arg === '--naive') strategy = 'naive';
  else if (arg === '--verify') verify = true;
  else if (arg === '--compact') compact = true;
  else if (arg === '-h' || arg === '--help') usage();
  else if (arg.startsWith('-')) usage();
  else if (file === null) file = arg;
  else usage();
}

const input = JSON.parse(file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'));
const report = buildReport(input, { strategy, verify });
process.stdout.write(JSON.stringify(report, null, compact ? 0 : 2) + '\n');
