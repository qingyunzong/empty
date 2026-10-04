#!/usr/bin/env node
// CLI: add / retract / solve --budget N
// Exit codes: 0 sat, 1 infeasible, 2 input error (bad JSON / duplicate id /
// invalid vector clock / unknown id), 3 unknown (budget exhausted).
import { readFileSync, writeSync } from 'node:fs';
import { EventStore } from './store.js';
import { InputError } from './event.js';
import { solve } from './solver.js';

const DEFAULT_DB = '.cea-events.json';

const out = (text) => writeSync(1, text);
const err = (text) => writeSync(2, text);

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, budget: 100000, maxSkewMs: 30000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') opts.db = argv[++i];
    else if (arg === '--budget') opts.budget = Number(argv[++i]);
    else if (arg === '--max-skew-ms') opts.maxSkewMs = Number(argv[++i]);
    else rest.push(arg);
  }
  return { opts, rest };
}

function cmdAdd(opts, rest) {
  const source = rest[0];
  if (!source) throw new InputError('usage: add <event.json | -> [--db PATH]');
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InputError(`bad JSON: ${source}`);
  }
  const store = EventStore.load(opts.db);
  const event = store.add(raw); // duplicate id / invalid vector clock -> InputError
  store.save(opts.db);
  out(`${JSON.stringify({ added: event.id })}\n`);
  return 0;
}

function cmdRetract(opts, rest) {
  const id = rest[0];
  if (!id) throw new InputError('usage: retract <id> [--db PATH]');
  const store = EventStore.load(opts.db);
  store.retract(id);
  store.save(opts.db);
  out(`${JSON.stringify({ retracted: id })}\n`);
  return 0;
}

function cmdSolve(opts) {
  if (!Number.isInteger(opts.budget) || opts.budget < 0) {
    throw new InputError('--budget must be a non-negative integer');
  }
  const store = EventStore.load(opts.db);
  const result = solve(store, { budget: opts.budget, maxSkewMs: opts.maxSkewMs });
  out(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'sat') return 0;
  if (result.status === 'infeasible') return 1;
  return 3; // unknown
}

function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const command = rest.shift();
  if (command === 'add') return cmdAdd(opts, rest);
  if (command === 'retract') return cmdRetract(opts, rest);
  if (command === 'solve') return cmdSolve(opts);
  throw new InputError('usage: cli.js <add|retract|solve> ...');
}

try {
  process.exitCode = main();
} catch (error) {
  err(`error: ${error.message}\n`);
  process.exitCode = error instanceof InputError ? 2 : 1;
}
