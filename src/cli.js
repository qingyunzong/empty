#!/usr/bin/env node
// Offline CLI: reads a scenario JSON file, schedules rework routes, and
// prints the result (routes, per-step budget deductions, preemptions,
// rollbacks, waiting queue, errors) as JSON.
//
// Usage:
//   node src/cli.js <input.json> [--out <file>] [--verify]
//
// Exit codes: 0 ok, 1 verification failed, 2 usage/IO/structural error.

import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeInput } from './model.js';
import { schedule } from './scheduler.js';
import { verifySchedule } from './verify.js';

function usage() {
  process.stderr.write('usage: rework-router <input.json> [--out <file>] [--verify]\n');
}

export function main(argv) {
  const args = argv.slice(2);
  let inputPath = null;
  let outPath = null;
  let verify = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--verify') {
      verify = true;
    } else if (arg === '--out') {
      outPath = args[i + 1];
      i += 1;
      if (!outPath) {
        usage();
        return 2;
      }
    } else if (arg.startsWith('--out=')) {
      outPath = arg.slice('--out='.length);
    } else if (arg.startsWith('-')) {
      usage();
      return 2;
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      usage();
      return 2;
    }
  }
  if (!inputPath) {
    usage();
    return 2;
  }

  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`error: cannot read input "${inputPath}": ${err.message}\n`);
    return 2;
  }

  let result;
  try {
    result = schedule(input);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }

  let exitCode = 0;
  if (verify) {
    const verification = verifySchedule(normalizeInput(input), result);
    result.verification = verification;
    if (!verification.ok) exitCode = 1;
  }

  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, output);
  } else {
    process.stdout.write(output);
  }
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv);
}
