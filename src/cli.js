import { readFileSync } from 'node:fs';
import { parseSpec } from './parser.js';
import { checkSpec } from './check.js';
import { checkHistory } from './history.js';
import { checkLinearizable } from './linearize.js';
import { LimError, EXIT_CODES } from './errors.js';

const USAGE = `usage: limit check <spec.lim> <history.json> [--max N]

Verdicts / exit codes:
  OK        (0)  history is linearizable; all valid sequential orders are printed
  PENDING   (${EXIT_CODES.E_PENDING})  linearizable, but some responses are unknown (PENDING, never treated as failure)
  E_LINEAR  (${EXIT_CODES.E_LINEAR})  no sequential order satisfies the limits and real-time order
  E_BOUND   (${EXIT_CODES.E_BOUND})  history exceeds the scale bound; no verdict is guessed
  E_TYPE    (${EXIT_CODES.E_TYPE})  spec or history failed static typing`;

export function main(argv, out = process.stdout, err = process.stderr) {
  const args = [...argv];
  if (args[0] !== 'check') {
    err.write(USAGE + '\n');
    return 1;
  }
  const files = [];
  let max = 8;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--max') {
      max = Number(args[++i]);
      if (!Number.isInteger(max) || max < 1) {
        err.write('E_TYPE: --max must be a positive integer\n');
        return EXIT_CODES.E_TYPE;
      }
    } else {
      files.push(args[i]);
    }
  }
  if (files.length !== 2) {
    err.write(USAGE + '\n');
    return 1;
  }
  try {
    const specSrc = readFileSync(files[0], 'utf8');
    const historyRaw = JSON.parse(readFileSync(files[1], 'utf8'));
    const spec = checkSpec(parseSpec(specSrc));
    const ops = checkHistory(spec, historyRaw);
    const verdict = checkLinearizable(spec, ops, { max });

    out.write(`status: ${verdict.status}\n`);
    if (verdict.pending.length > 0) {
      out.write(`pending: ${verdict.pending.join(' ')} (unknown response; not treated as failure)\n`);
    }
    out.write(`explored: ${verdict.explored} interleavings\n`);
    out.write(`linearizations: ${verdict.orders.length}\n`);
    for (const order of verdict.orders) out.write(order.join(' ') + '\n');
    return { OK: 0, PENDING: EXIT_CODES.E_PENDING, E_LINEAR: EXIT_CODES.E_LINEAR }[verdict.status];
  } catch (e) {
    if (e instanceof LimError) {
      err.write(e.message + '\n');
      return EXIT_CODES[e.code] ?? 1;
    }
    err.write(`E_TYPE: ${e.message}\n`);
    return EXIT_CODES.E_TYPE;
  }
}
