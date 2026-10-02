#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Planner } from './src/planner.js';
import { parseJsonl, buildDataset, datasetSnapshot } from './src/model.js';
import { InputError, InfeasibleError } from './src/errors.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function readJsonlFile(path, at) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch { throw new InputError('E_INPUT', at || path, `cannot read file`); }
  return parseJsonl(text, at || path);
}

function readJsonArg(value, at) {
  if (value.startsWith('@')) {
    try { return JSON.parse(readFileSync(value.slice(1), 'utf8')); }
    catch { throw new InputError('E_INPUT', at, 'cannot read/parse JSON file'); }
  }
  try { return JSON.parse(value); }
  catch { throw new InputError('E_INPUT', at, 'invalid JSON'); }
}

function emit(err) {
  process.stderr.write(JSON.stringify(err.toJSON ? err.toJSON() : { code: err.code || 'E_INTERNAL', at: err.message }) + '\n');
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const dir = args.dir || 'data';
const node = args.node || 'node-0';

try {
  if (cmd === 'plan') {
    const planner = new Planner(dir, node);
    let out;
    if (args.insert) {
      const order = readJsonArg(args.insert, '--insert');
      const context = args.context ? readJsonArg(args.context, '--context') : [];
      const r = planner.insert(order, context);
      if (r.status === 'rejected') {
        process.stderr.write(JSON.stringify({ code: 'E_CONFLICT', kept: r.kept, rejected: r.rejected, cert: r.cert.digest }) + '\n');
        process.exit(4);
      }
      out = { status: r.status, plan: r.plan ?? planner.currentPlan() };
    } else if (args.orders || args.molds || args.machines) {
      // validate with file:line locations first, then store the canonical snapshot
      const ds = buildDataset({
        orders: args.orders ? readJsonlFile(args.orders) : [],
        molds: args.molds ? readJsonlFile(args.molds) : [],
        machines: args.machines ? readJsonlFile(args.machines) : [],
        setups: args.setups ? readJsonlFile(args.setups) : [],
        operators: args.operators ? readJsonlFile(args.operators) : [],
      });
      out = { status: 'planned', plan: planner.load(datasetSnapshot(ds)) };
    } else {
      out = { status: 'current', plan: planner.currentPlan() };
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (cmd === 'undo') {
    const planner = new Planner(dir, node);
    const target = Number(args.to);
    const { plan, cert } = planner.undoTo(target);
    process.stdout.write(JSON.stringify({ status: 'ok', head: plan.headSeq, cert: cert.digest, plan }, null, 2) + '\n');
  } else if (cmd === 'verify') {
    const planner = new Planner(dir, node);
    const result = planner.verify();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exit(1);
  } else {
    process.stderr.write(JSON.stringify({ code: 'E_INPUT', at: 'argv', usage: 'plan [--orders F --molds F --machines F --setups F --operators F | --insert JSON] [--dir D] [--node N] | undo --to N [--dir D] | verify [--dir D]' }) + '\n');
    process.exit(2);
  }
} catch (err) {
  if (err instanceof InputError) { emit(err); process.exit(2); }
  if (err instanceof InfeasibleError) { emit(err); process.exit(3); }
  emit(err);
  process.exit(1);
}
