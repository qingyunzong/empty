#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { FormulaStore } from './store.js';
import { FormulaError } from './errors.js';

export function run(input) {
  const store = new FormulaStore(input.variables ?? {});
  const results = [];
  for (const cmd of input.commands ?? []) {
    try {
      let out;
      if (cmd.op === 'correct') out = store.correct(cmd.formula);
      else if (cmd.op === 'undo') out = store.undo();
      else if (cmd.op === 'redo') out = store.redo();
      else if (cmd.op === 'current') out = store.current();
      else throw new FormulaError('UNKNOWN_COMMAND', `unknown command "${cmd.op}"`);
      results.push({ op: cmd.op, ok: true, ...out });
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      const cur = store.current();
      results.push({
        op: cmd.op,
        ok: false,
        version: cur ? cur.version : null,
        error: err.toJSON(),
      });
    }
  }
  return { results };
}

function main() {
  const arg = process.argv[2];
  let input;
  try {
    input = JSON.parse(arg ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8'));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: `invalid input JSON: ${err.message}` }));
    process.exit(1);
  }
  try {
    process.stdout.write(JSON.stringify(run(input), null, 2) + '\n');
  } catch (err) {
    if (err instanceof FormulaError) {
      console.error(JSON.stringify({ ok: false, error: err.toJSON() }));
      process.exit(1);
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
