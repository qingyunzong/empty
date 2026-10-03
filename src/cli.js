import { parseArgs } from 'node:util';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { BudgetEngine, BudgetError } from './engine.js';

function parseInteger(raw, flag, { min }) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new BudgetError('E_INVALID', `${flag} must be an integer >= ${min}, got "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min) {
    throw new BudgetError('E_INVALID', `${flag} must be >= ${min}, got ${value}`);
  }
  return value;
}

function loadEngine(path) {
  if (!existsSync(path)) return new BudgetEngine();
  try {
    return BudgetEngine.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new BudgetError('E_IO', `cannot read database file "${path}"`);
  }
}

function saveEngine(path, engine) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(engine.toJSON(), null, 2)}\n`);
  renameSync(tmp, path);
}

function requireCategory(values, positionals) {
  const category = values.category ?? positionals[0];
  if (!category) throw new BudgetError('E_USAGE', 'missing required --category');
  return category;
}

const USAGE = [
  'usage:',
  '  node cli.js setbudget --category C --cap N [--db FILE]',
  '  node cli.js settle --category C --amount N [--db FILE]',
  '  node cli.js cancel --id ID [--db FILE]',
  '  node cli.js available C [--db FILE]',
].join('\n');

function execute(argv, env) {
  const [command, ...rest] = argv;
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: {
        db: { type: 'string', default: env.BUDGET_DB ?? 'budget.json' },
        category: { type: 'string' },
        amount: { type: 'string' },
        cap: { type: 'string' },
        id: { type: 'string' },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    throw new BudgetError('E_USAGE', `${err.message}\n${USAGE}`);
  }

  const engine = loadEngine(values.db);

  switch (command) {
    case 'setbudget': {
      const category = requireCategory(values, positionals);
      const cap = parseInteger(values.cap, '--cap', { min: 0 });
      engine.setBudget(category, cap);
      saveEngine(values.db, engine);
      return { command, category, cap };
    }
    case 'settle': {
      const category = requireCategory(values, positionals);
      const amount = parseInteger(values.amount, '--amount', { min: 1 });
      const txn = engine.begin();
      const id = txn.settle(category, amount);
      txn.commit();
      saveEngine(values.db, engine);
      return { command, id, category, amount, status: 'settled' };
    }
    case 'cancel': {
      const id = values.id ?? positionals[0];
      if (!id) throw new BudgetError('E_USAGE', 'missing required --id');
      const txn = engine.begin();
      txn.cancel(id);
      txn.commit();
      saveEngine(values.db, engine);
      return { command, id, status: 'cancelled' };
    }
    case 'available': {
      const category = requireCategory(values, positionals);
      const cap = engine.budgets.get(category);
      if (cap === undefined) {
        throw new BudgetError('E_NO_BUDGET', `no budget configured for category "${category}"`);
      }
      const used = engine.usedByCategoryIndex(category);
      return { command, category, cap, used, available: cap - used };
    }
    default:
      throw new BudgetError(
        'E_USAGE',
        command ? `unknown command "${command}"\n${USAGE}` : USAGE,
      );
  }
}

// Runs one CLI invocation in-process. Returns { status, stdout, stderr }:
// status 0 with a JSON result on stdout, or non-zero with a JSON error on stderr.
export function runCli(argv, env = process.env) {
  try {
    const result = execute(argv, env);
    return { status: 0, stdout: `${JSON.stringify({ ok: true, ...result })}\n`, stderr: '' };
  } catch (err) {
    const code = err instanceof BudgetError ? err.code : 'E_INTERNAL';
    const message = err?.message ?? String(err);
    return { status: 1, stdout: '', stderr: `${JSON.stringify({ error: { code, message } })}\n` };
  }
}
