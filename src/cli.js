#!/usr/bin/env node
// CLI: reads a JSONL event stream (file argument or stdin), prints one JSON
// object per line. Exit codes: 0 ok/SAT, 2 invalid input, 3 UNSAT, 4 PENDING.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Engine } from './engine.js';
import { InputError } from './model.js';

export const EXIT = Object.freeze({ OK: 0, INVALID_INPUT: 2, UNSAT: 3, PENDING: 4 });

export function run(input, opts = {}) {
  const engine = new Engine();
  if (opts.budget) engine.defaultBudget = { ...engine.defaultBudget, ...opts.budget };
  const outputs = [];
  let sawUnsat = false;
  let sawPending = false;
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      outputs.push({ type: 'error', code: 'INVALID_INPUT', line: i + 1, message: 'line is not valid JSON' });
      return { outputs, exitCode: EXIT.INVALID_INPUT };
    }
    let res;
    try {
      res = engine.applyEvent(raw);
    } catch (err) {
      if (err instanceof InputError) {
        outputs.push({ type: 'error', code: err.code, line: i + 1, message: err.message });
        return { outputs, exitCode: EXIT.INVALID_INPUT };
      }
      throw err;
    }
    if (res) {
      outputs.push({ line: i + 1, ...res });
      if (res.type === 'solve_result') {
        if (res.status === 'UNSAT') sawUnsat = true;
        if (res.status === 'PENDING') sawPending = true;
      }
    }
  }
  if (sawUnsat) return { outputs, exitCode: EXIT.UNSAT };
  if (sawPending) return { outputs, exitCode: EXIT.PENDING };
  return { outputs, exitCode: EXIT.OK };
}

const USAGE = `Usage: node src/cli.js [events.jsonl] [--budget-propagation N] [--budget-backtrack N]

Reads a JSONL event stream (config, add_obs, retract_obs, correct_obs,
checkpoint, undo_to, solve) from a file or stdin and prints one JSON object
per line. Exit codes: 0 ok/SAT, 2 invalid input, 3 UNSAT, 4 PENDING.`;

function main(argv) {
  let file = null;
  const budget = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE + '\n');
      return EXIT.OK;
    } else if (a === '--budget-propagation' || a === '--budget-backtrack') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) {
        process.stdout.write(JSON.stringify({ type: 'error', code: 'INVALID_INPUT', message: `${a} requires a non-negative integer` }) + '\n');
        return EXIT.INVALID_INPUT;
      }
      budget[a === '--budget-propagation' ? 'propagation' : 'backtrack'] = v;
    } else if (a.startsWith('--budget-propagation=') || a.startsWith('--budget-backtrack=')) {
      const [k, v] = a.split('=');
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        process.stdout.write(JSON.stringify({ type: 'error', code: 'INVALID_INPUT', message: `${k} requires a non-negative integer` }) + '\n');
        return EXIT.INVALID_INPUT;
      }
      budget[k === '--budget-propagation' ? 'propagation' : 'backtrack'] = n;
    } else if (file === null) {
      file = a;
    } else {
      process.stdout.write(JSON.stringify({ type: 'error', code: 'INVALID_INPUT', message: `unexpected argument: ${a}` }) + '\n');
      return EXIT.INVALID_INPUT;
    }
  }
  let input;
  try {
    input = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  } catch (err) {
    process.stdout.write(JSON.stringify({ type: 'error', code: 'INVALID_INPUT', message: `cannot read input: ${err.message}` }) + '\n');
    return EXIT.INVALID_INPUT;
  }
  const { outputs, exitCode } = run(input, { budget: Object.keys(budget).length ? budget : undefined });
  for (const o of outputs) process.stdout.write(JSON.stringify(o) + '\n');
  return exitCode;
}

const invokedAs = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedAs === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
