// CLI core, kept separate from the shebang wrapper so tests can run it
// in-process with captured output.

import { readFileSync } from 'node:fs';
import { parseModel, ValidationError } from './model.js';
import { solve } from './solver.js';
import { minimalConflict } from './conflict.js';

export const USAGE = 'usage: shed model.json --gap <mw> [--budget <nodes>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { modelPath: null, gap: null, budget: 1_000_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--gap') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new UsageError('--gap must be a non-negative integer');
      args.gap = value;
    } else if (arg === '--budget') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new UsageError('--budget must be a non-negative integer');
      args.budget = value;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}\n${USAGE}`);
    } else if (args.modelPath === null) {
      args.modelPath = arg;
    } else {
      throw new UsageError(`unexpected argument ${arg}\n${USAGE}`);
    }
  }
  if (args.modelPath === null) throw new UsageError(USAGE);
  return args;
}

// Returns the process exit code; writes JSON lines via the injected writers.
export function run(argv, { stdout, stderr, readFile = readFileSync } = {}) {
  const out = stdout ?? ((line) => process.stdout.write(line + '\n'));
  const err = stderr ?? ((line) => process.stderr.write(line + '\n'));
  const fail = (message) => { err(JSON.stringify({ error: message })); return 2; };

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message);
    throw e;
  }

  let text;
  try {
    text = readFile(args.modelPath, 'utf8');
  } catch (e) {
    return fail(`cannot read ${args.modelPath}: ${e.message}`);
  }

  let model;
  try {
    model = parseModel(text);
  } catch (e) {
    if (e instanceof ValidationError) return fail(e.message);
    throw e;
  }

  const gap = args.gap ?? model.gap;
  if (gap === null || gap === undefined) {
    return fail('no gap given (use --gap or "gap" in the model)');
  }

  const result = solve(model, { gap, budget: args.budget });

  if (result.status === 'ok') {
    out(JSON.stringify({
      status: 'ok',
      gap,
      shed: result.shed,
      cost: result.cost.toString(),
      plan: result.plan,
      nodes: result.nodes,
    }));
    return 0;
  }

  if (result.status === 'infeasible') {
    const conflict = minimalConflict(model, gap);
    out(JSON.stringify({
      status: 'infeasible',
      gap,
      maxShed: conflict.maxShed,
      conflict: { feeders: conflict.feeders, interlocks: conflict.interlocks },
      nodes: result.nodes,
    }));
    return 1;
  }

  out(JSON.stringify({
    status: 'unknown',
    gap,
    pending: result.pending,
    incumbent: result.incumbent
      ? { shed: result.incumbent.shed, cost: result.incumbent.cost.toString(), plan: result.incumbent.plan }
      : null,
    nodes: result.nodes,
  }));
  return 3;
}
