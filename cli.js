#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Scheduler, SchedError } = require('./src/scheduler');
const { enumerateFeasibleAssignments, selectOptimalAssignment } = require('./src/enumerate');

// Exit codes: 0 success, 1 domain/constraint error (E_BUDGET, ...), 2 usage error.

const USAGE = {
  commands: [
    'budget set <material> <day> <limit>',
    'order add <id> <plansJson>',
    'plan <orderId>',
    'commit <orderId>',
    'enumerate <orderId,orderId,...>',
    'allocations',
    'state',
  ],
  options: ['--db <path> (default ./scheduler-db.json)'],
};

class Exit extends Error {
  constructor(code, payload) {
    super(payload.error ? payload.error.message : 'exit');
    this.code = code;
    this.payload = payload;
  }
}

function ok(payload) {
  return { ok: true, ...payload };
}

function fail(code, message, details, exitCode) {
  throw new Exit(exitCode, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function usage(message) {
  fail('E_USAGE', message ?? 'invalid arguments', USAGE, 2);
}

function parseArgs(argv) {
  const args = [];
  let db = './scheduler-db.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      db = argv[++i];
      if (db === undefined) usage('missing value for --db');
    } else {
      args.push(argv[i]);
    }
  }
  return { args, db };
}

function loadLog(db) {
  if (!fs.existsSync(db)) return [];
  return JSON.parse(fs.readFileSync(db, 'utf8')).log;
}

function saveLog(db, log) {
  fs.writeFileSync(db, JSON.stringify({ version: 1, log }, null, 2) + '\n');
}

function replay(log) {
  const scheduler = new Scheduler();
  for (const op of log) {
    if (op.op === 'budget') scheduler.setBudget(op.material, op.day, op.limit);
    else if (op.op === 'order') scheduler.addOrder(op.id, op.plans);
    else if (op.op === 'commit') scheduler.scheduleOrder(op.orderId);
    else throw new Error(`unknown op in log: ${op.op}`);
  }
  return scheduler;
}

function run(argv) {
  const { args, db } = parseArgs(argv);
  const cmd = args[0];
  if (cmd === undefined) usage();
  const log = loadLog(db);
  const scheduler = replay(log);

  switch (cmd) {
    case 'budget': {
      if (args[1] !== 'set' || args.length !== 5) usage('budget set <material> <day> <limit>');
      const material = args[2];
      const day = Number(args[3]);
      const limit = Number(args[4]);
      if (!Number.isInteger(day) || day < 0 || !Number.isInteger(limit) || limit < 0) {
        usage('day and limit must be non-negative integers');
      }
      const budget = scheduler.setBudget(material, day, limit);
      log.push({ op: 'budget', material, day, limit });
      saveLog(db, log);
      return ok({ budget });
    }
    case 'order': {
      if (args[1] !== 'add' || args.length !== 4) usage('order add <id> <plansJson>');
      const id = args[2];
      let plans;
      try {
        plans = JSON.parse(args[3]);
      } catch {
        usage('plansJson is not valid JSON');
      }
      const order = scheduler.addOrder(id, plans);
      log.push({ op: 'order', id, plans: order.plans });
      saveLog(db, log);
      return ok({ order });
    }
    case 'plan': {
      if (args.length !== 2) usage('plan <orderId>');
      return ok(scheduler.planOrder(args[1]));
    }
    case 'commit': {
      if (args.length !== 2) usage('commit <orderId>');
      const result = scheduler.scheduleOrder(args[1]);
      log.push({ op: 'commit', orderId: args[1] });
      saveLog(db, log);
      return ok(result);
    }
    case 'enumerate': {
      if (args.length !== 2) usage('enumerate <orderId,orderId,...>');
      const ids = args[1].split(',');
      if (ids.length === 0 || ids.length > 3) usage('enumerate supports 1..3 orders');
      const orders = ids.map((id) => {
        const order = scheduler.getOrder(id);
        if (!order) fail('E_ORDER_NOT_FOUND', `unknown order: ${id}`, undefined, 1);
        return order;
      });
      const budgets = [];
      for (const [key, chain] of scheduler.store.data) {
        if (key.startsWith('budget|') && chain.length) budgets.push(chain[chain.length - 1].value);
      }
      const assignments = enumerateFeasibleAssignments(orders, budgets);
      return ok({
        count: assignments.length,
        assignments,
        optimal: selectOptimalAssignment(assignments),
      });
    }
    case 'allocations':
      return ok({ allocations: scheduler.allocations() });
    case 'state':
      return ok({ commitSeq: scheduler.store.commitSeq, log });
    default:
      usage(`unknown command: ${cmd}`);
  }
}

function execute(argv) {
  let payload;
  let code = 0;
  try {
    payload = run(argv);
  } catch (err) {
    if (err instanceof Exit) {
      payload = err.payload;
      code = err.code;
    } else if (err instanceof SchedError) {
      payload = { ok: false, error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } };
      code = 1;
    } else {
      payload = { ok: false, error: { code: 'E_INTERNAL', message: err.message } };
      code = 1;
    }
  }
  return { code, payload };
}

function main() {
  const { code, payload } = execute(process.argv.slice(2));
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n', () => {
    process.exitCode = code;
  });
}

if (require.main === module) main();

module.exports = { run, execute };
