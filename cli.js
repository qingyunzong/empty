#!/usr/bin/env node
// CLI for the quality traceability library.
//
//   node cli.js trace input.json [--state PATH] [--budget N]
//   node cli.js undo  [--state PATH]
//   node cli.js redo  [--state PATH]
//
// Exit codes: 0 feasible / ok, 1 infeasible, 2 invalid input or usage,
//             3 unknown (budget exhausted).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseModel, InputError } from './src/model.js';
import { TraceStore } from './src/store.js';
import { runTrace } from './src/trace.js';

export const EXIT = { feasible: 0, infeasible: 1, invalid: 2, unknown: 3 };
const DEFAULT_STATE = '.trace-state.json';

function fail(message, code = EXIT.invalid) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { _: [], state: DEFAULT_STATE, budget: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') args.state = argv[++i];
    else if (a === '--budget') args.budget = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

function loadStore(path) {
  if (!existsSync(path)) fail(`state file not found: ${path} (run "trace" first)`);
  try {
    return TraceStore.from(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    fail(`state file is corrupted: ${path}`);
  }
}

function saveStore(path, store) {
  writeFileSync(path, `${JSON.stringify(store.toJSON(), null, 2)}\n`);
}

function cmdTrace(args) {
  const inputPath = args._[0];
  if (!inputPath) fail('usage: trace <input.json> [--state PATH] [--budget N]');
  if (args.budget !== undefined && (!Number.isInteger(args.budget) || args.budget <= 0)) {
    fail('--budget must be a positive integer');
  }
  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, 'utf8'));
  } catch (err) {
    fail(`cannot read input: ${err.message}`);
  }
  let model;
  try {
    model = parseModel(input);
  } catch (err) {
    if (err instanceof InputError) fail(err.message);
    throw err;
  }
  const budget = args.budget ?? model.budget;
  const { store, result } = runTrace(model, { budget });
  saveStore(args.state, store);
  const out = {
    status: result.status,
    edges: result.edges,
    derived: result.derived,
    proof: result.proof,
    pending: result.pending,
    stats: result.stats,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(EXIT[result.status]);
}

function cmdUndoRedo(args, which) {
  const store = loadStore(args.state);
  const label = which === 'undo' ? store.undo() : store.redo();
  if (label === null) fail(`nothing to ${which}`, EXIT.invalid);
  saveStore(args.state, store);
  const out = {
    status: 'ok',
    [which]: label,
    batches: Object.keys(store.state.batches).length,
    edges: store.state.edges.length,
    derived: Object.keys(store.state.derived),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (cmd === 'trace') cmdTrace(args);
else if (cmd === 'undo') cmdUndoRedo(args, 'undo');
else if (cmd === 'redo') cmdUndoRedo(args, 'redo');
else fail('usage: cli.js <trace|undo|redo> ...');
