#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Store } = require('./src/state');

const DEFAULT_STATE_PATH = '.sched-state.json';

class UsageError extends Error {}

function readJSON(arg) {
  const text = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  return JSON.parse(text);
}

function parseArgs(argv) {
  const positional = [];
  let statePath = DEFAULT_STATE_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      i += 1;
      if (i >= argv.length) throw new UsageError('--state requires a path');
      statePath = argv[i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, statePath };
}

function loadStore(statePath) {
  if (!fs.existsSync(statePath)) {
    throw new Error(`state file not found: ${statePath} (run 'schedule' first)`);
  }
  return Store.fromJSON(JSON.parse(fs.readFileSync(statePath, 'utf8')));
}

function saveStore(statePath, store) {
  fs.writeFileSync(statePath, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

const USAGE = [
  'usage:',
  '  node cli.js schedule <problem.json> [--state path]',
  '  node cli.js apply <edit.json> [--state path]',
  '  node cli.js undo [--state path]',
  '  node cli.js redo [--state path]',
  'exit codes: 0 = feasible schedule, 1 = infeasible (certificate printed), 2 = error',
].join('\n');

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, statePath } = parseArgs(rest);
  let output;
  switch (command) {
    case 'schedule': {
      if (positional.length !== 1) throw new UsageError(USAGE);
      const store = Store.create(readJSON(positional[0]));
      saveStore(statePath, store);
      output = { ...store.result, undoDepth: 0, redoDepth: 0 };
      break;
    }
    case 'apply': {
      if (positional.length !== 1) throw new UsageError(USAGE);
      const store = loadStore(statePath);
      output = store.applyEdit(readJSON(positional[0]));
      saveStore(statePath, store);
      break;
    }
    case 'undo':
    case 'redo': {
      if (positional.length !== 0) throw new UsageError(USAGE);
      const store = loadStore(statePath);
      output = command === 'undo' ? store.undo() : store.redo();
      saveStore(statePath, store);
      break;
    }
    default:
      throw new UsageError(USAGE);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = output.feasible === false ? 1 : 0;
}

try {
  main();
} catch (err) {
  const code = err instanceof UsageError ? 2 : 2;
  process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
  process.exitCode = code;
}
