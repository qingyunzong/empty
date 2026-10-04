#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runOps } from './src/engine.js';

const arg = process.argv[2];
const raw = arg ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');

let outputs;
try {
  const input = JSON.parse(raw);
  outputs = runOps(Array.isArray(input) ? input : input.ops);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: { code: err.code || 'INVALID_INPUT', message: err.message } }, null, 2)}\n`);
  process.exit(2);
}

process.stdout.write(`${JSON.stringify({ outputs }, null, 2)}\n`);
process.exit(outputs.some((o) => !o.ok) ? 1 : 0);
