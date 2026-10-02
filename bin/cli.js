#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

// JSON-lines CLI: one JSON command per line on stdin (or a file given as the
// first argument), one JSON result per line on stdout. Errors are reported as
// {"ok":false,"type":"error","code":...} lines; processing continues.
const engine = new Engine();

function emit(obj) {
  if (obj !== null && obj !== undefined) process.stdout.write(JSON.stringify(obj) + '\n');
}

const file = process.argv[2];
if (file) {
  for (const line of readFileSync(file, 'utf8').split('\n')) emit(engine.handleLine(line));
} else {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => emit(engine.handleLine(line)));
}
