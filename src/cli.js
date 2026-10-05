#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simulate } from './scheduler.js';
import { ValidationError } from './model.js';

// Returns the process exit code. `io` is injectable for tests.
export function main(args, io = {}) {
  const readFile = io.readFile ?? ((f) => readFileSync(f, 'utf8'));
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  const fail = (code, message) => {
    stderr(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    return 1;
  };

  const file = args.find((a) => a !== '--compact');
  const compact = args.includes('--compact');

  let raw;
  try {
    raw = file ? readFile(file) : readStdin();
  } catch (e) {
    return fail('READ_ERROR', `cannot read input: ${e.message}`);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    return fail('INVALID_JSON', `input is not valid JSON: ${e.message}`);
  }

  try {
    const report = simulate(input);
    stdout(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ValidationError || e.code) {
      return fail(e.code, e.message);
    }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
