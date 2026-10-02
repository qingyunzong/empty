#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { validateHistory, InvalidHistoryError } from '../src/validate.js';
import { findWitnesses } from '../src/checker.js';
import { minimalConflict } from '../src/conflict.js';

function emit(payload, code) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function main() {
  const [command, file] = process.argv.slice(2);
  if (command !== 'linearize' || !file) {
    process.stderr.write('usage: linearize <history.json>\n');
    process.exit(2);
  }

  let history;
  try {
    history = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    emit({ status: 'INVALID_HISTORY', errors: [`cannot read/parse ${file}: ${error.message}`] }, 2);
  }

  let ops;
  try {
    ops = validateHistory(history);
  } catch (error) {
    if (error instanceof InvalidHistoryError) {
      emit({ status: 'INVALID_HISTORY', errors: error.errors }, 2);
    }
    throw error;
  }

  const [witness] = findWitnesses(ops, { limit: 1 });
  if (witness) {
    emit({ status: 'LINEARIZABLE', witness }, 0);
  }
  emit({ status: 'NOT_LINEARIZABLE', conflict: minimalConflict(ops) }, 1);
}

main();
