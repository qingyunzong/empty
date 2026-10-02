#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runCommand, USAGE } from '../src/cli.js';
import { DqError } from '../src/index.js';

function readInput(argv) {
  const file = argv[3];
  const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function main() {
  const command = process.argv[2];
  if (!command || command === '-h' || command === '--help') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }
  const output = runCommand(command, readInput(process.argv));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof DqError) {
    const body = { error: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    console.error(JSON.stringify(body));
    process.exit(1);
  }
  if (err instanceof SyntaxError) {
    console.error(JSON.stringify({ error: 'BAD_INPUT', message: `invalid JSON: ${err.message}` }));
    process.exit(1);
  }
  throw err;
}
