#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execute, deriveState, batchStatus, LedgerError } from './src/ledger.js';
import { loadEvents, appendEvents } from './src/store.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// Returns the process exit code (0 success, 1 error). Errors are reported as
// standard error JSON: {"error":{"code":"...","message":"..."}}.
export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  const fail = (code, message) => {
    stderr(JSON.stringify({ error: { code, message } }) + '\n');
    return 1;
  };

  const args = parseArgs(argv);
  const command = args._[0];
  if (!command) {
    return fail('INVALID_INPUT', 'usage: node cli.js <command> --input <file> --store <file> [--output <file>]');
  }
  if (!args.input || !args.store) return fail('INVALID_INPUT', '--input and --store are required');

  let cmd;
  try {
    cmd = JSON.parse(readFileSync(args.input, 'utf8'));
  } catch (err) {
    return fail('INVALID_INPUT', `cannot read/parse input file: ${err.message}`);
  }

  let events;
  try {
    events = loadEvents(args.store);
  } catch (err) {
    if (err instanceof LedgerError) return fail(err.code, err.message);
    return fail('STORE_ERROR', err.message);
  }
  const state = deriveState(events);

  try {
    if (command === 'status') {
      emit(args, batchStatus(state, cmd.batchId), stdout);
      return 0;
    }
    const { events: newEvents, result } = execute(state, command, cmd);
    appendEvents(args.store, newEvents);
    emit(args, result, stdout);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) return fail(err.code, err.message);
    return fail('INTERNAL', err.message);
  }
}

function emit(args, result, stdout) {
  const text = JSON.stringify(result, null, 2) + '\n';
  if (args.output) {
    writeFileSync(args.output, text, 'utf8');
  } else {
    stdout(text);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
