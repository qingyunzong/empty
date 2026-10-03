#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  applyEvent,
  balance,
  createReplica,
  diff,
  merge,
  summary,
} from './src/replica.js';

class CliError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function loadState(path) {
  if (!path || !existsSync(path)) throw new CliError('no-such-replica');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError('invalid-state');
  }
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('invalid-json');
  }
}

// Executes one CLI invocation. emit receives each output object; returns the
// process exit code (0 on success, 1 on any error).
export function execute(argv, emit) {
  try {
    run(argv, emit);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      emit({ error: err.code });
      return 1;
    }
    throw err;
  }
}

function run(argv, emit) {
  const [statePath, command, arg] = argv;
  if (!statePath || !command) throw new CliError('usage');

  switch (command) {
    case 'init': {
      const limit = Number(arg);
      if (!Number.isFinite(limit) || limit < 0) throw new CliError('invalid-limit');
      const state = createReplica(limit);
      saveState(statePath, state);
      emit({ ok: true, ...balance(state) });
      break;
    }
    case 'reserve':
    case 'release': {
      const state = loadState(statePath);
      const payload = parseJson(arg);
      const result = applyEvent(state, { ...payload, type: command });
      if (!result.ok) throw new CliError(result.error);
      saveState(statePath, state);
      emit({ ok: true, changed: result.changed, ...balance(state) });
      break;
    }
    case 'diff': {
      // Emits the events the replica in <file> is missing relative to this one.
      const state = loadState(statePath);
      const other = loadState(arg);
      emit({ missing: diff(state, summary(other)) });
      break;
    }
    case 'repair': {
      const state = loadState(statePath);
      if (!arg || !existsSync(arg)) throw new CliError('no-such-file');
      const doc = parseJson(readFileSync(arg, 'utf8'));
      const events = Array.isArray(doc) ? doc : doc.missing ?? doc.events;
      const result = merge(state, events);
      if (!result.ok) throw new CliError(result.error);
      saveState(statePath, state);
      emit({ ok: true, ...balance(state) });
      break;
    }
    case 'balance': {
      emit(balance(loadState(statePath)));
      break;
    }
    case 'summary': {
      emit(summary(loadState(statePath)));
      break;
    }
    default:
      throw new CliError('unknown-command');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const code = execute(process.argv.slice(2), (value) => {
    process.stdout.write(JSON.stringify(value) + '\n');
  });
  process.exit(code);
}
