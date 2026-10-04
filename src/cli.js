'use strict';

const { Planner, PlanError } = require('./planner');
const { syncPeers } = require('./sync');

function fail(code, exitCode, message) {
  throw new PlanError(code, exitCode, message);
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[key] = args[++i];
      else flags[key] = 'true';
    }
  }
  return flags;
}

function num(flags, key) {
  const v = Number(flags[key]);
  if (flags[key] === undefined || Number.isNaN(v)) {
    fail('USAGE', 2, `missing or invalid --${key}`);
  }
  return v;
}

function req(flags, key) {
  if (flags[key] === undefined) fail('USAGE', 2, `missing --${key}`);
  return flags[key];
}

function buildOp(flags) {
  switch (flags.op) {
    case 'shift':
      return ['shift', { id: req(flags, 'shift'), capacity: num(flags, 'capacity') }];
    case 'mold':
      return ['mold', { id: req(flags, 'mold'), life: num(flags, 'life') }];
    case 'setup':
      return ['setup', { mold: req(flags, 'mold'), minutes: num(flags, 'minutes') }];
    case 'changeover':
      return ['changeover', { from: req(flags, 'from'), to: req(flags, 'to'), minutes: num(flags, 'minutes') }];
    case 'insert':
      return ['insert', {
        job: req(flags, 'job'), mold: req(flags, 'mold'),
        shots: num(flags, 'shots'), duration: num(flags, 'duration')
      }];
    case 'assign':
      return ['assign', { job: req(flags, 'job'), shift: req(flags, 'shift') }];
    case 'unassign':
      return ['unassign', { job: req(flags, 'job') }];
    case 'maintenance':
      return ['maintenance', {
        id: req(flags, 'id'), mold: req(flags, 'mold'), shift: req(flags, 'shift'),
        duration: num(flags, 'duration'), locked: flags.locked === 'true'
      }];
    case 'pend':
      return ['pend', { job: req(flags, 'job') }];
    case 'unpend':
      return ['unpend', { job: req(flags, 'job') }];
    default:
      fail('USAGE', 2, `unknown op: ${flags.op}`);
  }
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitResult(res) {
  print(res);
  if (!res.feasible) fail('INFEASIBLE', 3, `no feasible plan under current budget (${res.reason})`);
}

function cmdPlan(flags) {
  const p = Planner.open(req(flags, 'state'));
  emitResult(p.plan());
}

function cmdApply(flags) {
  const p = Planner.open(req(flags, 'state'));
  let entry = null;
  if (flags.op !== undefined) {
    const [op, data] = buildOp(flags);
    entry = p.op(op, data);
  }
  const res = p.apply();
  if (entry) res.applied = entry.opId;
  emitResult(res);
}

function cmdRollback(flags) {
  const p = Planner.open(req(flags, 'state'));
  const n = flags.n === undefined ? 1 : num(flags, 'n');
  print(p.rollback(n));
}

function cmdSync(flags) {
  const out = syncPeers(req(flags, 'state'), req(flags, 'peer'));
  print(out);
  if (!out.a.result.feasible || !out.b.result.feasible) {
    fail('INFEASIBLE', 3, 'sync converged to an infeasible plan');
  }
}

function cmdVerify(flags) {
  const p = Planner.open(req(flags, 'state'));
  const res = p.verify();
  print(res);
  if (!res.ok) fail('CORRUPT', 2, 'verification failed');
}

const COMMANDS = {
  plan: cmdPlan,
  apply: cmdApply,
  rollback: cmdRollback,
  sync: cmdSync,
  verify: cmdVerify
};

function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    const handler = COMMANDS[cmd];
    if (!handler) {
      fail('USAGE', 2,
        `usage: mold-plan <${Object.keys(COMMANDS).join('|')}> --state DIR [options]`);
    }
    handler(parseFlags(rest));
  } catch (e) {
    if (e instanceof PlanError) {
      process.stderr.write(JSON.stringify({ error: { code: e.code, message: e.message } }) + '\n');
      process.exitCode = e.exitCode;
    } else {
      process.stderr.write(JSON.stringify({ error: { code: 'INTERNAL', message: String((e && e.message) || e) } }) + '\n');
      process.exitCode = 2;
    }
  }
}

module.exports = { main };
