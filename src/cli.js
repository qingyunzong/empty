#!/usr/bin/env node
import fs from 'node:fs';
import { compile } from './compiler.js';
import { Engine } from './engine.js';
import { loadState, saveState, committedBoundaryOf } from './state.js';
import { CrashError } from './errors.js';

const USAGE = `Usage: obs-correct --input records.json --script corrections.txt [options]

Options:
  --input PATH       JSON file containing an array of observation records (required)
  --script PATH      Correction script file (required)
  --batch-size N     Records per batch (default: 10)
  --crash N          Simulate a crash after the Nth executed bytecode instruction
  --state PATH       State file for checkpoint/commit persistence and resume
  --output PATH      Write the JSON report here instead of stdout
  -h, --help         Show this help

Exit codes: 0 = success, 1 = processing failure (batch rolled back),
            2 = simulated crash, 3 = usage/IO error.`;

function parseArgs(argv) {
  const args = { batchSize: 10, crash: null, state: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case '--input': args.input = next(); break;
      case '--script': args.script = next(); break;
      case '--batch-size': args.batchSize = Number(next()); break;
      case '--crash': args.crash = Number(next()); break;
      case '--state': args.state = next(); break;
      case '--output': args.output = next(); break;
      case '-h':
      case '--help': console.log(USAGE); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.input) throw new Error('--input is required');
  if (!args.script) throw new Error('--script is required');
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
    throw new Error('--batch-size must be a positive integer');
  }
  if (args.crash !== null && (!Number.isInteger(args.crash) || args.crash < 1)) {
    throw new Error('--crash must be a positive integer');
  }
  return args;
}

function emit(report, output) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) fs.writeFileSync(output, text, 'utf8');
  else process.stdout.write(text);
}

// Sets the exit code instead of calling process.exit(): exiting explicitly
// would truncate pending async writes when stdout is a pipe.
function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  let records;
  let program;
  try {
    records = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    if (!Array.isArray(records)) throw new Error('input must be a JSON array');
    program = compile(fs.readFileSync(args.script, 'utf8'));
  } catch (err) {
    console.error(`Failed to load input: ${err.message}`);
    process.exitCode = 3;
    return;
  }

  let state = null;
  try {
    state = loadState(args.state);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 3;
    return;
  }

  const engine = new Engine(program, { batchSize: args.batchSize, crashAfter: args.crash });
  const onState = args.state ? (s) => saveState(args.state, s) : null;

  try {
    const result = engine.run(records, { state, onState });
    if (result.ok) {
      emit({ ok: true, records: result.records, batches: result.batches }, args.output);
      return;
    }
    emit({
      ok: false,
      error: result.error,
      committedBoundary: result.committedBoundary,
      records: result.records,
      batches: result.batches,
    }, args.output);
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof CrashError) {
      emit({
        ok: false,
        crashed: true,
        afterInstruction: err.afterInstruction,
        committedBoundary: args.state ? committedBoundaryOf(args.state) : 0,
      }, args.output);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

main();
