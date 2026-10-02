#!/usr/bin/env node
// Offline injection-molding scheduler CLI.
//
//   node cli.js [solve] <instance.json|->   solve (default); '-' or no path = stdin
//   node cli.js verify <instance.json> <solution.json>   re-verify a certificate
//
// Exit codes: 0 = success (including a proven-infeasible solve),
//             1 = invalid input / usage error (message on stderr),
//             1 = verification failed (verify mode).

import { readFileSync } from 'node:fs';
import { validateInstance, InputError } from './src/instance.js';
import { solve } from './src/solver.js';
import { verifySolution } from './src/verify.js';

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readJson(path) {
  let text;
  try {
    text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON in ${path === '-' ? 'stdin' : path}: ${err.message}`);
  }
}

function parseInstance(raw, source) {
  try {
    return validateInstance(raw);
  } catch (err) {
    if (err instanceof InputError) fail(`invalid instance in ${source}: ${err.message}`);
    throw err;
  }
}

const args = process.argv.slice(2);
let command = 'solve';
if (args[0] === 'solve' || args[0] === 'verify') command = args.shift();

if (command === 'solve') {
  const path = args[0] ?? '-';
  const instance = parseInstance(readJson(path), path);
  const solution = solve(instance);
  process.stdout.write(`${JSON.stringify(solution, null, 2)}\n`);
} else {
  if (args.length !== 2) fail('usage: node cli.js verify <instance.json> <solution.json>');
  const instance = parseInstance(readJson(args[0]), args[0]);
  const solution = readJson(args[1]);
  const certificate = verifySolution(instance, solution);
  process.stdout.write(`${JSON.stringify(certificate, null, 2)}\n`);
  process.exit(certificate.ok ? 0 : 1);
}
