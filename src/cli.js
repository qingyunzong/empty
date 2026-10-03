#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ValidationError } from './model.js';
import { TraceStore } from './store.js';
import { solve } from './solve.js';

export const EXIT_CODES = { feasible: 0, infeasible: 1, invalid: 2, unknown: 3 };

const USAGE = `usage:
  trace <input.json> [--state <path>] [--budget <n>]   add a transaction and solve
  trace undo [--state <path>]                          revert the last transaction
  trace redo [--state <path>]                          re-apply the reverted transaction

exit codes: 0 feasible, 1 infeasible, 2 invalid input, 3 unknown (budget exhausted)`;

function parseOptions(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') {
      options.state = args[i + 1];
      i += 1;
    } else if (args[i] === '--budget') {
      options.budget = Number(args[i + 1]);
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, options };
}

function loadState(path) {
  if (!existsSync(path)) return { undoStack: [], redoStack: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ValidationError(`state file is corrupt: ${path}`);
  }
}

function saveState(path, store) {
  writeFileSync(path, `${JSON.stringify(store.toJSON(), null, 2)}\n`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function failInvalid(error) {
  print({ status: 'invalid', error: error.message });
  return EXIT_CODES.invalid;
}

export function run(argv) {
  const [command, ...rest] = argv;
  if (!command || !['trace', 'undo', 'redo'].includes(command)) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_CODES.invalid;
  }
  const { positional, options } = parseOptions(rest);
  const statePath = options.state ?? 'trace.state.json';
  if (options.budget !== undefined && (!Number.isInteger(options.budget) || options.budget < 0)) {
    return failInvalid(new ValidationError(`--budget must be a non-negative integer, got ${options.budget}`));
  }

  try {
    const store = TraceStore.from(loadState(statePath));

    if (command === 'trace') {
      const inputPath = positional[0];
      if (!inputPath) {
        process.stderr.write(`${USAGE}\n`);
        return EXIT_CODES.invalid;
      }
      let raw;
      try {
        raw = JSON.parse(readFileSync(inputPath, 'utf8'));
      } catch (err) {
        return failInvalid(new ValidationError(`cannot read or parse ${inputPath}: ${err.message}`));
      }
      store.applyTransaction({ materials: raw.materials ?? [], batches: raw.batches ?? [] });
      const budget = options.budget ?? raw.budget ?? 100000;
      const result = solve(store, { budget });
      saveState(statePath, store);
      print(result);
      return EXIT_CODES[result.status];
    }

    const moved = command === 'undo' ? store.undo() : store.redo();
    if (!moved) {
      print({ status: command === 'undo' ? 'nothing-to-undo' : 'nothing-to-redo' });
      return EXIT_CODES.feasible;
    }
    const result = solve(store, { budget: options.budget ?? 100000 });
    saveState(statePath, store);
    print({ status: command === 'undo' ? 'undone' : 'redone', depth: store.undoStack.length, result });
    return EXIT_CODES.feasible;
  } catch (err) {
    if (err instanceof ValidationError) return failInvalid(err);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
