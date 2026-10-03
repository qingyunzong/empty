#!/usr/bin/env node
// Offline budget settlement CLI.
//
// Commands:
//   budget set-budget --category C --limit N
//   budget settle --category C --amount N [--id ID]
//   budget cancel --id ID
//   budget available C
//
// Global options:
//   --db PATH   data file (default: $BUDGET_DB or ./budget.json)
//
// Success: JSON on stdout, exit 0. Failure: JSON error on stderr, exit 1.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BudgetDB, BudgetError, transact } from './db.js';

const E_USAGE = 'E_USAGE';
const E_STORAGE = 'E_STORAGE';
const E_INTERNAL = 'E_INTERNAL';

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new BudgetError(E_USAGE, `missing value for --${name}`);
      }
      options[name] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function parseInteger(raw, name) {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    throw new BudgetError(E_USAGE, `--${name} must be an integer`);
  }
  return Number.parseInt(raw, 10);
}

function loadDb(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new BudgetDB();
    throw new BudgetError(E_STORAGE, `cannot read ${path}: ${err.message}`);
  }
  try {
    return BudgetDB.fromJSON(JSON.parse(text));
  } catch {
    throw new BudgetError(E_STORAGE, `cannot parse ${path}: invalid JSON`);
  }
}

function saveDb(path, db) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(db.toJSON()) + '\n');
    renameSync(tmp, path);
  } catch (err) {
    throw new BudgetError(E_STORAGE, `cannot write ${path}: ${err.message}`);
  }
}

function newId() {
  return `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function execute(argv, env) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0];
  const dbPath = options.db ?? env.BUDGET_DB ?? './budget.json';

  if (!command) {
    throw new BudgetError(E_USAGE,
      'usage: budget <set-budget|settle|cancel|available> [--db PATH]');
  }

  const db = loadDb(dbPath);

  switch (command) {
    case 'set-budget': {
      const category = options.category;
      if (!category) throw new BudgetError(E_USAGE, 'set-budget requires --category');
      const limit = parseInteger(options.limit, 'limit');
      db.setBudget(category, limit);
      saveDb(dbPath, db);
      return { ok: true, category, limit };
    }
    case 'settle': {
      const category = options.category;
      if (!category) throw new BudgetError(E_USAGE, 'settle requires --category');
      const amount = parseInteger(options.amount, 'amount');
      const id = options.id ?? newId();
      transact(db, (tx) => tx.settle({ id, category, amount }));
      saveDb(dbPath, db);
      return { ok: true, id, category, amount, status: 'settled' };
    }
    case 'cancel': {
      const id = options.id;
      if (!id) throw new BudgetError(E_USAGE, 'cancel requires --id');
      transact(db, (tx) => tx.cancel(id));
      saveDb(dbPath, db);
      return { ok: true, id, status: 'cancelled' };
    }
    case 'available': {
      const category = positional[1] ?? options.category;
      if (!category) throw new BudgetError(E_USAGE, 'available requires a category');
      const tx = db.begin();
      const available = tx.available(category);
      const limit = db.getBudget(category);
      return {
        category,
        available,
        used: limit === Infinity ? 0 : limit - available,
        limit: limit === Infinity ? null : limit,
      };
    }
    default:
      throw new BudgetError(E_USAGE, `unknown command: ${command}`);
  }
}

// Runs the CLI and returns {status, stdout, stderr} exactly as the process
// would produce them. Kept pure (no process.exit / console output) so tests
// can exercise the full command surface in-process.
export function run(argv, env = {}) {
  try {
    const result = execute(argv, env);
    return { status: 0, stdout: JSON.stringify(result) + '\n', stderr: '' };
  } catch (err) {
    const code = err instanceof BudgetError ? err.code : E_INTERNAL;
    const message = err && err.message ? err.message : String(err);
    return { status: 1, stdout: '', stderr: JSON.stringify({ error: code, message }) + '\n' };
  }
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const { status, stdout, stderr } = run(process.argv.slice(2), process.env);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(status);
}
