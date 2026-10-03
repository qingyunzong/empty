#!/usr/bin/env node
// clearsync — deterministic clearing-channel scheduler CLI.
// Usage: clearsync [input.json | -]   (defaults to stdin)
// Output: { schedule, certificates, errors } on stdout.
// Exit code 2 when errors are present or the input is invalid, 0 otherwise.
import { readFileSync } from 'node:fs';
import { run } from './index.js';

function readInput(arg) {
  if (arg === undefined || arg === '-') return readFileSync(0, 'utf8');
  return readFileSync(arg, 'utf8');
}

let output;
try {
  const raw = JSON.parse(readInput(process.argv[2]));
  output = run(raw);
} catch (err) {
  output = {
    schedule: [],
    certificates: [],
    errors: [{ code: 'INVALID_INPUT', message: `failed to read/parse input: ${err.message}` }],
  };
}

process.exitCode = output.errors.length > 0 ? 2 : 0;
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
