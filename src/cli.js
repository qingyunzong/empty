import { readFileSync, writeFileSync } from 'node:fs';
import { ModelError, Store, StoreError } from './store.js';

export const EXIT = { OK: 0, UNSAT: 2, PENDING: 3, USAGE: 4 };

const USAGE = `usage: furnace <command> [--state PATH] [options]

commands:
  init        --days N --max-runs-per-day N --slots N --gas-budget N
              --max-temp-diff N --crucibles type:count,...
              --gas-usage atmo:units,... --hazards a:b;c:d
              [--required-priority N]
  add_recipe  --id ID --priority N --temps t,... --atmos a,... --durs d,...
              --crucible TYPE
  lock_slot   --recipe ID --batch N --temp T --atmo A --dur D
  unlock_slot --recipe ID
  snapshot
  restore
  optimize    [--budget-propagate N] [--budget-backtrack N] [--budget-improve N]

exit codes: 0 optimal/ok, 2 unsat, 3 pending (budget exhausted), 4 usage error
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new StoreError(`missing value for --${key}`);
      }
      args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (args, key, { required = true } = {}) => {
  const raw = args[key];
  if (raw === undefined) {
    if (required) throw new StoreError(`missing --${key}`);
    return undefined;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new StoreError(`--${key} must be a number, got: ${raw}`);
  return v;
};

const str = (args, key) => {
  const raw = args[key];
  if (raw === undefined) throw new StoreError(`missing --${key}`);
  return raw;
};

const list = (args, key) => str(args, key).split(',').filter((s) => s.length > 0);

const intList = (args, key) =>
  list(args, key).map((s) => {
    const v = Number(s);
    if (!Number.isInteger(v)) throw new StoreError(`--${key} expects integers, got: ${s}`);
    return v;
  });

const pairs = (args, key, { integer = false } = {}) => {
  const out = {};
  for (const item of list(args, key)) {
    const [k, v] = item.split(':');
    if (!k || v === undefined) throw new StoreError(`--${key} expects k:v entries, got: ${item}`);
    const val = Number(v);
    if (!Number.isFinite(val) || (integer && !Number.isInteger(val))) {
      throw new StoreError(`--${key} expects numeric values, got: ${item}`);
    }
    out[k] = val;
  }
  return out;
};

const groups = (args, key) =>
  str(args, key)
    .split(';')
    .filter((s) => s.length > 0)
    .map((g) => g.split(':').filter((s) => s.length > 0));

function loadStore(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return new Store();
  }
  try {
    return Store.fromJSON(JSON.parse(raw));
  } catch {
    throw new StoreError(`corrupt state file: ${path}`);
  }
}

function saveStore(path, store) {
  writeFileSync(path, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const say = (s) => stdout.write(s + '\n');
  try {
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === 'help' || cmd === '--help') {
      say(USAGE);
      return cmd ? EXIT.OK : EXIT.USAGE;
    }
    const args = parseArgs(rest);
    const statePath = args.state ?? '.furnace-state.json';
    const store = loadStore(statePath);

    switch (cmd) {
      case 'init': {
        store.init({
          days: num(args, 'days'),
          maxRunsPerDay: num(args, 'max-runs-per-day'),
          slots: num(args, 'slots'),
          gasBudget: num(args, 'gas-budget'),
          maxTempDiff: num(args, 'max-temp-diff'),
          crucibles: pairs(args, 'crucibles', { integer: true }),
          gasUsage: pairs(args, 'gas-usage'),
          hazards: groups(args, 'hazards'),
          ...(args['required-priority'] !== undefined
            ? { requiredPriority: num(args, 'required-priority') }
            : {}),
        });
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'init' }));
        return EXIT.OK;
      }
      case 'add_recipe': {
        store.addRecipe({
          id: str(args, 'id'),
          priority: num(args, 'priority'),
          temps: intList(args, 'temps'),
          atmos: list(args, 'atmos'),
          durs: intList(args, 'durs'),
          crucible: str(args, 'crucible'),
        });
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'add_recipe', id: args.id }));
        return EXIT.OK;
      }
      case 'lock_slot': {
        store.lock(str(args, 'recipe'), {
          batch: num(args, 'batch'),
          temp: num(args, 'temp'),
          atmo: str(args, 'atmo'),
          dur: num(args, 'dur'),
        });
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'lock_slot', recipe: args.recipe }));
        return EXIT.OK;
      }
      case 'unlock_slot': {
        store.unlock(str(args, 'recipe'));
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'unlock_slot', recipe: args.recipe }));
        return EXIT.OK;
      }
      case 'snapshot': {
        const depth = store.snapshot();
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'snapshot', depth }));
        return EXIT.OK;
      }
      case 'restore': {
        const depth = store.restore();
        saveStore(statePath, store);
        say(JSON.stringify({ ok: true, command: 'restore', depth }));
        return EXIT.OK;
      }
      case 'optimize': {
        const budgets = {};
        if (args['budget-propagate'] !== undefined) budgets.propagate = num(args, 'budget-propagate');
        if (args['budget-backtrack'] !== undefined) budgets.backtrack = num(args, 'budget-backtrack');
        if (args['budget-improve'] !== undefined) budgets.improve = num(args, 'budget-improve');
        const result = store.optimize(budgets);
        saveStore(statePath, store);
        say(JSON.stringify(result, null, 2));
        if (result.status === 'UNSAT') return EXIT.UNSAT;
        if (result.status === 'PENDING') return EXIT.PENDING;
        return EXIT.OK;
      }
      default:
        stderr.write(`error: unknown command: ${cmd}\n`);
        stderr.write(USAGE);
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof StoreError || e instanceof ModelError) {
      stderr.write(`error: ${e.message}\n`);
      return EXIT.USAGE;
    }
    throw e;
  }
}
