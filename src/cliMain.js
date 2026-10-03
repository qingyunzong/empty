// Testable CLI core: pure argument/IO handling, returns { code, stdout, stderr }
// instead of touching process.exit. cli.js maps the result onto the process.

import { readFileSync } from 'node:fs';
import { checkLinearizability } from './checker.js';
import { InvalidHistory } from './model.js';

export const EXIT_OK = 0;           // well-formed history (linearizable or not)
export const EXIT_INVALID = 1;      // INVALID_HISTORY
export const EXIT_USAGE = 2;        // CLI usage error

const USAGE = 'usage: node cli.js check <history.json> [--initial-balance N]';

export function runCli(argv) {
  const [command, file, ...rest] = argv;
  if (command !== 'check' || !file) {
    return { code: EXIT_USAGE, stdout: '', stderr: `${USAGE}\n` };
  }

  let initialBalance = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--initial-balance') {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        return { code: EXIT_USAGE, stdout: '', stderr: '--initial-balance must be a non-negative number\n' };
      }
      initialBalance = value;
      i++;
    } else {
      return { code: EXIT_USAGE, stdout: '', stderr: `${USAGE}\n` };
    }
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { code: EXIT_INVALID, stdout: '', stderr: `INVALID_HISTORY: cannot read/parse ${file}: ${err.message}\n` };
  }

  try {
    const result = checkLinearizability(data, { initialBalance });
    return { code: EXIT_OK, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  } catch (err) {
    if (err instanceof InvalidHistory || err.code === 'INVALID_HISTORY') {
      return { code: EXIT_INVALID, stdout: '', stderr: `INVALID_HISTORY: ${err.message}\n` };
    }
    throw err;
  }
}
