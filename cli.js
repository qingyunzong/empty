#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { linearize } from './src/linearize.js';
import { InvalidHistoryError } from './src/validate.js';

const EXIT = { LINEARIZABLE: 0, NOT_LINEARIZABLE: 1, INVALID_HISTORY: 2, USAGE: 3 };

const [, , command, file] = process.argv;

function emit(payload, code) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exitCode = code;
}

if (command !== 'linearize' || !file) {
  process.stderr.write('usage: linearize <history.json>\n');
  process.exitCode = EXIT.USAGE;
} else {
  let input;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    emit({ status: 'INVALID_HISTORY', errors: [`cannot read/parse ${file}: ${err.message}`] }, EXIT.INVALID_HISTORY);
    input = undefined;
  }

  if (input !== undefined) {
    try {
      const result = linearize(input);
      emit(result, EXIT[result.status]);
    } catch (err) {
      if (err instanceof InvalidHistoryError) {
        emit({ status: 'INVALID_HISTORY', errors: err.errors }, EXIT.INVALID_HISTORY);
      } else {
        throw err;
      }
    }
  }
}
