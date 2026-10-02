#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { adjudicate } from './src/index.js';

function usage() {
  console.error('usage: node cli.js <logfile> [--explain]');
  console.error('  log lines:  evt node=<id> clock=<n> seq=<n> op=<commit|mask|rollback> key=<k> [value=<v>]');
  console.error('              note: <free text>');
  process.exit(64);
}

const args = process.argv.slice(2);
const explain = args.includes('--explain');
const files = args.filter((a) => a !== '--explain');
if (files.length !== 1) usage();

let source;
try {
  source = readFileSync(files[0], 'utf8');
} catch (err) {
  console.error(`error: cannot read ${files[0]}: ${err.message}`);
  process.exit(66);
}

let result;
try {
  result = adjudicate(source);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(65);
}

if (explain) {
  console.log('causal edges (happens-before, transitively reduced):');
  if (result.edges.length === 0) console.log('  (none — all events are concurrent)');
  for (const edge of result.edges) {
    console.log(`  ${edge.from} -> ${edge.to}  [${edge.reason}]`);
  }
  console.log(`deterministic order: ${result.order.join('  ')}`);
}

console.log(`events: ${result.eventCount}, applied: ${result.applied}`);
if (result.conflict) {
  console.log('CONFLICT CERTIFICATE');
  console.log(`  key:    ${result.conflict.key}`);
  console.log(`  clock:  ${result.conflict.clock}`);
  console.log(`  reason: ${result.conflict.reason}`);
  for (const e of result.conflict.events) {
    console.log(`  event:  ${e.id} value=${e.value} (line ${e.line})`);
  }
}
console.log('final state:');
console.log(JSON.stringify(result.state, null, 2));
process.exit(0);
