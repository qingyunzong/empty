#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { validateInput, simulate } from './scheduler.js';
import * as store from './store.js';

export const EXIT_CODES = {
  INVALID_INPUT: 1,
  ATOMIC_SPLIT: 2,
  WINDOW_FULL: 3,
  QUOTA: 4,
  PARTIAL_COMMIT: 5,
  STATE_MISMATCH: 6,
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { data: 'data' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--data') opts.data = rest[++i];
    else if (rest[i].startsWith('--data=')) opts.data = rest[i].slice('--data='.length);
    else return { error: { code: 'INVALID_INPUT', message: `unknown argument: ${rest[i]}` } };
  }
  return { command, opts };
}

function cmdPlan(dir, out) {
  const input = store.loadInput(dir);
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const state = store.loadState(dir);
  const sim = simulate(input, state);
  out({
    command: 'plan',
    pending: Object.keys(state.remaining).length,
    waits: state.waits,
    rounds: sim.rounds,
    proof: sim.proof,
  });
  return 0;
}

function cmdCommit(dir, out) {
  const input = store.loadInput(dir);
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const result = store.commitNext(dir);
  if (!result) {
    out({ command: 'commit', committed: null, message: 'no waiting batches', proof: store.loadState(dir).proof });
    return 0;
  }
  out({
    command: 'commit',
    committed: result.round,
    waits: result.state.waits,
    proof: result.state.proof,
  });
  return 0;
}

function cmdRecover(dir, out) {
  const { rolledBack, committed, state } = store.recover(dir);
  out({
    command: 'recover',
    ok: true,
    code: rolledBack.length > 0 ? 'PARTIAL_COMMIT' : 'OK',
    rolledBack,
    committedRounds: committed,
    pending: Object.keys(state.remaining).length,
    waits: state.waits,
    proof: state.proof,
  });
  return 0;
}

function cmdVerify(dir, out) {
  const result = store.verify(dir);
  if (!result.ok) {
    const first = result.errors[0];
    return { code: first.code, message: first.message, errors: result.errors };
  }
  out({ command: 'verify', ok: true, rounds: result.rounds, proof: result.proof });
  return 0;
}

// Programmatic entry: returns the exit code, writes JSON through io.
export function run(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const emit = (obj) => io.stdout(`${JSON.stringify(obj, null, 2)}\n`);
  const fail = (err) => {
    io.stderr(`${JSON.stringify({ error: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) })}\n`);
    return EXIT_CODES[err.code] ?? 1;
  };
  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);
  const { command, opts } = parsed;
  try {
    switch (command) {
      case 'plan':
        return finish(cmdPlan(opts.data, emit), fail);
      case 'commit':
        return finish(cmdCommit(opts.data, emit), fail);
      case 'recover':
        return finish(cmdRecover(opts.data, emit), fail);
      case 'verify':
        return finish(cmdVerify(opts.data, emit), fail);
      default:
        return fail({ code: 'INVALID_INPUT', message: 'usage: clearing <plan|commit|recover|verify> [--data DIR]' });
    }
  } catch (err) {
    if (err && err.code && EXIT_CODES[err.code]) return fail(err);
    return fail({ code: 'INVALID_INPUT', message: err.message ?? String(err) });
  }
}

function finish(result, fail) {
  if (typeof result === 'object' && result !== null) return fail(result);
  return result;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exit(run(process.argv.slice(2)));
}
