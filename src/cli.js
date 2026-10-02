#!/usr/bin/env node
// Offline causal event analyzer CLI.
//
//   node src/cli.js add '<event-json>' [--store path] [--window N]
//   node src/cli.js retract <id>       [--store path]
//   node src/cli.js solve --budget N   [--store path] [--window N]
//
// Exit codes: 0 success; 1 unknown id on retract / unexpected failure;
// 2 bad JSON, duplicate id, illegal vector clock, invalid store or usage.
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { Solver, ValidationError, DuplicateIdError } from './solver.js';

function fail(message, code = 2) {
  writeSync(2, `error: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--store' || arg === '--budget' || arg === '--window') {
      if (i + 1 >= argv.length) fail(`option ${arg} requires a value`);
      opts[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('--')) {
      fail(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function parseNonNegativeInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

function loadStore(path) {
  if (!existsSync(path)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`store file ${path} contains invalid JSON`);
  }
  if (!Array.isArray(data)) fail(`store file ${path} must contain a JSON array of events`);
  return data;
}

function saveStore(path, events) {
  writeFileSync(path, JSON.stringify(events, null, 2) + '\n');
}

function buildSolver(events, window) {
  const solver = new Solver({ window });
  for (const raw of events) {
    try {
      solver.addEvent(raw);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof DuplicateIdError) {
        fail(`store: ${err.message}`);
      }
      throw err;
    }
  }
  return solver;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, opts } = parseArgs(rest);
  const store = opts.store ?? 'events.json';
  const window = opts.window === undefined ? 5 : parseNonNegativeInt(opts.window, '--window');

  if (cmd === 'add') {
    if (positional.length !== 1) fail('usage: add <event-json> [--store path] [--window N]');
    let raw;
    try {
      raw = JSON.parse(positional[0]);
    } catch {
      fail(`invalid event JSON: ${positional[0]}`);
    }
    const events = loadStore(store);
    const solver = buildSolver(events, window);
    let ev;
    try {
      ev = solver.addEvent(raw);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof DuplicateIdError) fail(err.message);
      throw err;
    }
    events.push(ev);
    saveStore(store, events);
    process.stdout.write(`added ${ev.id}\n`);
    return;
  }

  if (cmd === 'retract') {
    if (positional.length !== 1) fail('usage: retract <id> [--store path]');
    const id = positional[0];
    const events = loadStore(store);
    if (!events.some((e) => e && e.id === id)) fail(`unknown event id: ${id}`, 1);
    saveStore(store, events.filter((e) => e.id !== id));
    process.stdout.write(`retracted ${id}\n`);
    return;
  }

  if (cmd === 'solve') {
    if (positional.length !== 0) fail('usage: solve [--budget N] [--store path] [--window N]');
    const budget = opts.budget === undefined ? Infinity : parseNonNegativeInt(opts.budget, '--budget');
    const events = loadStore(store);
    const solver = buildSolver(events, window);
    const result = solver.solve({ budget });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  fail('usage: <add|retract|solve> (see src/cli.js header)');
}

main();
