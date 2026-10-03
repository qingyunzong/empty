#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fold } from '../src/fold.js';

function usage() {
  console.error('usage: escrow fold <ticks.jsonl> [--at seqN]');
  console.error('  each line: {"seq": <int>, "text": "<DSL statement>"}');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] !== 'fold' || !args[1]) usage();

const file = args[1];
let at = null;
const ai = args.indexOf('--at');
if (ai !== -1) {
  at = Number(args[ai + 1]);
  if (!Number.isInteger(at) || at < 0) {
    console.error(`error: --at expects a non-negative integer, got ${args[ai + 1]}`);
    process.exit(2);
  }
}

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`error: cannot read ${file}: ${e.message}`);
  process.exit(2);
}

const events = [];
const lines = raw.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    console.error(`error: line ${i + 1}: invalid JSON`);
    process.exit(2);
  }
}

const res = fold(events, { at });
if (!res.ok) {
  console.error(`error ${res.error.code} at seq ${res.seq}: ${res.error.message}`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(res.state, null, 2) + '\n');
