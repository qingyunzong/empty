#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validate, ValidationError } from './validate.js';
import { solve } from './solver.js';

const EXIT_OK = 0;
const EXIT_INFEASIBLE = 1;
const EXIT_INPUT_ERROR = 2;
const EXIT_UNKNOWN = 3;

export function run(argv, { stdout = console.log, stderr = console.error } = {}) {
  const args = [...argv];
  if (args[0] === 'plan') args.shift();

  let budget = 500;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--budget') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v < 0) {
        stderr('error: --budget must be a non-negative integer');
        return EXIT_INPUT_ERROR;
      }
      budget = v;
    } else if (a.startsWith('--budget=')) {
      const v = Number(a.slice('--budget='.length));
      if (!Number.isInteger(v) || v < 0) {
        stderr('error: --budget must be a non-negative integer');
        return EXIT_INPUT_ERROR;
      }
      budget = v;
    } else if (a.startsWith('-')) {
      stderr(`error: unknown option ${a}`);
      return EXIT_INPUT_ERROR;
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    stderr('usage: plan <input.json> [--budget N]');
    return EXIT_INPUT_ERROR;
  }

  let input;
  try {
    input = JSON.parse(readFileSync(positional[0], 'utf8'));
  } catch (e) {
    stderr(`error: cannot read or parse ${positional[0]}: ${e.message}`);
    return EXIT_INPUT_ERROR;
  }

  try {
    validate(input);
  } catch (e) {
    if (e instanceof ValidationError) {
      stderr(JSON.stringify({ error: e.errors }, null, 2));
      return EXIT_INPUT_ERROR;
    }
    throw e;
  }

  const result = solve(input, { budget });
  stdout(JSON.stringify(result, null, 2));

  if (result.status === 'optimal') return EXIT_OK;
  if (result.status === 'infeasible') return EXIT_INFEASIBLE;
  return EXIT_UNKNOWN;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
