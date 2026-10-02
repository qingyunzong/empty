#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fuzzRun } from './src/fuzz.js';
import { replayRun } from './src/replay.js';
import { InvalidInputError } from './src/errors.js';

function fail(message) {
  console.error(`INVALID_INPUT: ${message}`);
  process.exit(1);
}

function parseFlags(args, allowed) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      fail(`unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!allowed.has(key)) {
      fail(`unknown flag: --${key}`);
    }
    if (i + 1 >= args.length) {
      fail(`missing value for --${key}`);
    }
    flags[key] = args[i + 1];
    i += 1;
  }
  return flags;
}

function parseInteger(raw, name) {
  if (raw === undefined) {
    fail(`missing required flag: --${name}`);
  }
  if (!/^-?\d+$/.test(raw)) {
    fail(`${name} must be an integer, got: ${raw}`);
  }
  return Number.parseInt(raw, 10);
}

function commandFuzz(args) {
  const flags = parseFlags(args, new Set(['seed', 'steps', 'accounts', 'out']));
  const seed = parseInteger(flags.seed, 'seed');
  const steps = parseInteger(flags.steps, 'steps');
  const accounts = parseInteger(flags.accounts, 'accounts');
  if (flags.out === undefined) {
    fail('missing required flag: --out');
  }
  let run;
  try {
    run = fuzzRun({ seed, steps, accounts });
  } catch (error) {
    if (error instanceof InvalidInputError) {
      fail(error.message);
    }
    throw error;
  }
  writeFileSync(flags.out, JSON.stringify(run, null, 2) + '\n');
  console.log(`seed=${run.seed} steps=${run.steps} accounts=${run.accounts}`);
  console.log(`ops=${run.ops.length} samples=${run.sampleCount}`);
  console.log(`finalStateHash=${run.finalStateHash}`);
  console.log(`sampleHash=${run.sampleHash}`);
  console.log(`out=${flags.out}`);
}

function commandReplay(args) {
  if (args.length !== 1 || args[0].startsWith('--')) {
    fail('usage: replay <run.json>');
  }
  let run;
  try {
    run = JSON.parse(readFileSync(args[0], 'utf8'));
  } catch (error) {
    fail(`cannot read run file ${args[0]}: ${error.message}`);
  }
  let outcome;
  try {
    outcome = replayRun(run);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      fail(error.message);
    }
    throw error;
  }
  console.log(`ops=${outcome.opCount}`);
  console.log(`finalStateHash=${outcome.finalStateHash}`);
  console.log(`sampleHash=${outcome.sampleHash}`);
  if (!outcome.ok) {
    for (const mismatch of outcome.mismatches) {
      console.error(`REPLAY_MISMATCH: ${mismatch}`);
    }
    process.exit(1);
  }
  console.log('REPLAY_OK');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'fuzz') {
  commandFuzz(rest);
} else if (command === 'replay') {
  commandReplay(rest);
} else {
  fail(`unknown command: ${command ?? '(none)'}. expected "fuzz" or "replay"`);
}
