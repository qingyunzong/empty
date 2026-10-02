#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ValidationError } from './src/model.js';
import { solveWithConflict } from './src/solver.js';

function statePath(inputFile) {
  return `${inputFile}.state.json`;
}

function loadState(inputFile) {
  const path = statePath(inputFile);
  if (!existsSync(path)) return { nextId: 1, holds: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { nextId: parsed.nextId ?? 1, holds: Array.isArray(parsed.holds) ? parsed.holds : [] };
}

function saveState(inputFile, state) {
  writeFileSync(statePath(inputFile), JSON.stringify(state, null, 2));
}

function loadInput(inputFile) {
  let text;
  try {
    text = readFileSync(inputFile, 'utf8');
  } catch (e) {
    throw new ValidationError(`cannot read input file ${inputFile}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ValidationError(`invalid JSON in ${inputFile}: ${e.message}`);
  }
}

function parseOpts(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new ValidationError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ValidationError(`missing value for --${key}`);
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function parseIntOpt(opts, key, { min, required = false }) {
  const raw = opts[key];
  if (raw === undefined) {
    if (required) throw new ValidationError(`missing required option --${key}`);
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) throw new ValidationError(`--${key} must be an integer, got ${JSON.stringify(raw)}`);
  const value = Number(raw);
  if (min !== undefined && value < min) throw new ValidationError(`--${key} must be >= ${min}, got ${value}`);
  return value;
}

const USAGE = [
  'usage:',
  '  tank-sched assign <input.json> [--budget N]',
  '  tank-sched hold <input.json> --tank T --start S --duration D [--label L]',
  '  tank-sched release <input.json> --id HOLD_ID_OR_LABEL',
  '',
].join('\n');

// Programmatic entry: returns the exit code, writes via io.out / io.err.
export function cliMain(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const print = (obj) => io.out(JSON.stringify(obj, null, 2) + '\n');
  try {
    const [cmd, inputFile, ...rest] = argv;
    if (!cmd || !inputFile) {
      io.err(USAGE);
      return 2;
    }
    const opts = parseOpts(rest);
    switch (cmd) {
      case 'assign': {
        const raw = loadInput(inputFile);
        const state = loadState(inputFile);
        if (state.holds.length > 0) raw.holds = state.holds;
        const budget = parseIntOpt(opts, 'budget', { min: 0 });
        const result = solveWithConflict(raw, budget === undefined ? {} : { budget });
        print(result);
        return result.status === 'feasible' ? 0 : 1;
      }
      case 'hold': {
        const tank = opts.tank;
        if (typeof tank !== 'string') throw new ValidationError('missing required option --tank');
        const start = parseIntOpt(opts, 'start', { min: 0, required: true });
        const duration = parseIntOpt(opts, 'duration', { min: 1, required: true });
        const label = opts.label ?? null;
        const raw = loadInput(inputFile);
        const state = loadState(inputFile);
        const hold = { id: `H${state.nextId}`, tank, start, duration, ...(label ? { label } : {}) };
        const candidate = { ...raw, holds: [...state.holds, hold] };
        const result = solveWithConflict(candidate);
        if (result.status !== 'feasible') {
          // Rollback: state file untouched, locked tasks unaffected.
          print({ status: 'failed', reason: result.status, hold, ...(result.conflict ? { conflict: result.conflict } : {}) });
          return 1;
        }
        state.holds.push(hold);
        state.nextId += 1;
        saveState(inputFile, state);
        print({ status: 'held', hold });
        return 0;
      }
      case 'release': {
        const id = opts.id;
        if (typeof id !== 'string') throw new ValidationError('missing required option --id');
        const state = loadState(inputFile);
        const idx = state.holds.findIndex((h) => h.id === id || h.label === id);
        if (idx === -1) {
          print({ status: 'failed', reason: `no hold with id or label ${JSON.stringify(id)}` });
          return 1;
        }
        const [removed] = state.holds.splice(idx, 1);
        saveState(inputFile, state);
        print({ status: 'released', hold: removed });
        return 0;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      io.err(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = cliMain(process.argv.slice(2));
}
