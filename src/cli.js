import fs from 'node:fs';
import { parseSpec } from './parser.js';
import { compile } from './compile.js';
import { normalizeHistory, typecheckHistory } from './history.js';
import { check, DEFAULT_MAX } from './linearize.js';
import { LimError, E_LINEAR, E_PENDING, E_TYPE, exitCodeFor } from './errors.js';

const USAGE = `usage: limit check <spec.lim> [history.json] [--max N] [--strict-pending]

Checks whether a concurrent reservation history is linearizable against the
capacity limits declared in the spec. If history.json is omitted, an embedded
'history { ... }' block in the spec is used.

exit codes: 0 linearizable, 1 E_LINEAR, 2 E_TYPE, 3 E_BOUND, 4 E_PENDING`;

export function main(argv, { stdout = console.log, stderr = console.error } = {}) {
  try {
    const args = [...argv];
    const cmd = args.shift();
    if (cmd !== 'check') { stderr(USAGE); return 64; }
    const positional = [];
    let max = DEFAULT_MAX;
    let strictPending = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--max') {
        max = Number(args[i + 1]);
        if (!Number.isInteger(max) || max < 1) {
          throw new LimError(E_TYPE, `--max must be a positive integer, got '${args[i + 1]}'`);
        }
        i += 1;
      } else if (args[i] === '--strict-pending') strictPending = true;
      else positional.push(args[i]);
    }
    const [specFile, historyFile] = positional;
    if (!specFile) { stderr(USAGE); return 64; }

    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'));
    const model = compile(spec);
    let ops;
    if (historyFile) {
      ops = normalizeHistory(JSON.parse(fs.readFileSync(historyFile, 'utf8')), historyFile);
    } else if (spec.history.length > 0) {
      ops = spec.history;
    } else {
      throw new LimError(E_TYPE, 'no history provided (pass history.json or embed a history block in the spec)');
    }
    typecheckHistory(model, ops);

    if (strictPending && ops.some((o) => o.response === null)) {
      throw new LimError(E_PENDING, 'history contains PENDING operations and --strict-pending was given');
    }

    const result = check(model, ops, { max });
    const warnings = [];
    if (result.pending.length > 0) {
      warnings.push({
        code: E_PENDING,
        message: `${result.pending.length} operation(s) have no recorded response `
          + `and were treated as possibly completed: ${result.pending.join(', ')}`,
      });
    }
    if (!result.linearizable) {
      stdout(JSON.stringify({
        linearizable: false,
        error: { code: E_LINEAR, message: 'no sequential order satisfies the capacity constraints and the real-time order' },
        pending: result.pending,
        explored: result.explored,
        warnings,
      }, null, 2));
      return exitCodeFor(E_LINEAR);
    }
    stdout(JSON.stringify({
      linearizable: true,
      count: result.orders.length,
      validOrders: result.orders,
      pending: result.pending,
      explored: result.explored,
      warnings,
    }, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof LimError) {
      stderr(JSON.stringify({ error: { code: err.code, message: err.message } }));
      return exitCodeFor(err.code);
    }
    throw err;
  }
}
