#!/usr/bin/env node
// Offline tank scheduling CLI.
//   assign  <input.json> [--budget N] [--state PATH]
//   hold    <input.json> --id H --tank T --start S --duration D [--material M] [--state PATH]
//   release <input.json> (--id H | --all) [--state PATH]
// Exit codes: 0 ok/feasible, 1 infeasible or hold/release failure,
//             2 invalid input (illegal time or capacity), 3 unknown (budget exhausted).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { validateProblem, validateHold, InputError } from './problem.js';
import { Scheduler } from './scheduler.js';
import { minimalConflict } from './conflict.js';

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function failInput(message) {
  throw new InputError(message);
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    failInput(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    failInput(`invalid JSON in ${path}: ${err.message}`);
  }
}

function statePathFor(inputPath, option) {
  return option ?? `${inputPath}.state.json`;
}

function loadHolds(path) {
  if (!existsSync(path)) return [];
  const raw = readJson(path);
  if (!raw || !Array.isArray(raw.holds)) failInput(`invalid state file ${path}`);
  return raw.holds.map(validateHold);
}

function saveHolds(path, holds) {
  writeFileSync(path, `${JSON.stringify({ holds }, null, 2)}\n`);
}

function toInteger(value, name) {
  const num = Number(value);
  if (!Number.isInteger(num)) failInput(`${name} must be an integer, got "${value}"`);
  return num;
}

function commandAssign(inputPath, options) {
  const problem = validateProblem(readJson(inputPath));
  const holds = loadHolds(statePathFor(inputPath, options.state));
  const budget = options.budget !== undefined
    ? toInteger(options.budget, 'budget')
    : Number.MAX_SAFE_INTEGER;
  if (budget < 0) failInput('budget must be non-negative');
  const scheduler = new Scheduler(problem, { holds });
  const result = scheduler.solve({ budget });
  if (result.status === 'feasible') {
    printJson({ status: 'feasible', assignments: result.assignments });
    return 0;
  }
  if (result.status === 'unknown') {
    printJson({ status: 'unknown', pending: result.pending });
    return 3;
  }
  const conflict = minimalConflict(problem, holds);
  printJson({ status: 'infeasible', conflict });
  return 1;
}

function commandHold(inputPath, options) {
  const problem = validateProblem(readJson(inputPath));
  const statePath = statePathFor(inputPath, options.state);
  const holds = loadHolds(statePath);
  for (const name of ['id', 'tank', 'start', 'duration']) {
    if (options[name] === undefined) failInput(`hold requires --${name}`);
  }
  const occupation = validateHold({
    id: options.id,
    tank: options.tank,
    start: toInteger(options.start, 'start'),
    duration: toInteger(options.duration, 'duration'),
    material: options.material ?? null,
  });
  const scheduler = new Scheduler(problem, { holds });
  const outcome = scheduler.hold(occupation);
  if (!outcome.ok) {
    // Rollback already happened inside the scheduler; the state file is untouched.
    printJson({ status: 'hold_failed', id: occupation.id, reason: outcome.reason });
    return 1;
  }
  holds.push(occupation);
  saveHolds(statePath, holds);
  printJson({ status: 'held', id: occupation.id });
  return 0;
}

function commandRelease(inputPath, options) {
  validateProblem(readJson(inputPath));
  const statePath = statePathFor(inputPath, options.state);
  const holds = loadHolds(statePath);
  if (options.all) {
    saveHolds(statePath, []);
    printJson({ status: 'released', released: holds.map((hold) => hold.id) });
    return 0;
  }
  if (options.id === undefined) failInput('release requires --id or --all');
  const remaining = holds.filter((hold) => hold.id !== options.id);
  if (remaining.length === holds.length) {
    printJson({ status: 'not_found', id: options.id });
    return 1;
  }
  saveHolds(statePath, remaining);
  printJson({ status: 'released', released: [options.id] });
  return 0;
}

function main(argv) {
  const [command, inputPath, ...rest] = argv;
  if (!command || !inputPath || !['assign', 'hold', 'release'].includes(command)) {
    process.stderr.write('usage: tank-sched <assign|hold|release> <input.json> [options]\n');
    return 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      budget: { type: 'string' },
      state: { type: 'string' },
      id: { type: 'string' },
      tank: { type: 'string' },
      start: { type: 'string' },
      duration: { type: 'string' },
      material: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (command === 'assign') return commandAssign(inputPath, values);
  if (command === 'hold') return commandHold(inputPath, values);
  return commandRelease(inputPath, values);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof InputError) {
    process.stderr.write(`invalid input: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
  }
}
