#!/usr/bin/env node
'use strict';
// Usage:
//   node cli.js append --history f --data '{"opId":...}'   (or JSON on stdin)
//   node cli.js judge  --history f --config accounts.json [--pretty]
//   node cli.js repair --history f --config accounts.json --op id1 [--op id2 ...] [--pretty]
//
// Crash-recovery test hooks (repair only, via env):
//   REPAIR_CRASH_BEFORE_WRITE=1  stop after planning, before any append
//   REPAIR_CRASH_MID_WRITE=1     write a torn partial first record, then stop
const fs = require('fs');
const { readHistory, appendRecord, validateOp } = require('./src/log');
const { judge } = require('./src/judge');
const { planRepair, applyRepair } = require('./src/repair');

function parseArgs(argv) {
  const args = { ops: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') args.history = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--op') args.ops.push(argv[++i]);
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--pretty') args.pretty = true;
    else if (!args.command) args.command = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return args;
}

// Returns the process exit code. `env` and `io` are injectable for tests.
function run(argv, env = process.env, io = { out: (s) => console.log(s), err: (s) => console.error(s), stdin: null }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`error: ${e.message}`);
    return 1;
  }
  const historyPath = args.history || 'history.ndjson';

  try {
    switch (args.command) {
      case 'append': {
        const raw = args.data !== undefined ? args.data : io.stdin;
        if (raw == null) throw new Error('append requires --data or piped stdin');
        const rec = JSON.parse(raw);
        const err = validateOp(rec);
        if (err) throw new Error(`invalid operation: ${err}`);
        const { records } = readHistory(historyPath);
        const byId = new Map(records.map((r) => [r.opId, r]));
        for (const d of rec.deps || []) {
          const dep = byId.get(d);
          if (!dep) throw new Error(`unknown dep '${d}'`);
          if (dep.account !== rec.account) throw new Error(`dep '${d}' belongs to account '${dep.account}'`);
        }
        appendRecord(historyPath, rec);
        io.out(JSON.stringify({ appended: rec.opId }));
        return 0;
      }
      case 'judge': {
        const configs = JSON.parse(fs.readFileSync(args.config || 'accounts.json', 'utf8'));
        const { records, warnings } = readHistory(historyPath);
        warnings.forEach((w) => io.err(`warning: ${w}`));
        io.out(JSON.stringify(judge(records, configs), null, args.pretty ? 2 : 0));
        return 0;
      }
      case 'repair': {
        const configs = JSON.parse(fs.readFileSync(args.config || 'accounts.json', 'utf8'));
        const { records, warnings } = readHistory(historyPath);
        warnings.forEach((w) => io.err(`warning: ${w}`));
        const plan = planRepair(records, configs, args.ops);
        if (env.REPAIR_CRASH_BEFORE_WRITE) {
          io.err('simulated crash before writing compensations');
          return 2;
        }
        if (env.REPAIR_CRASH_MID_WRITE && plan.appends.length > 0) {
          fs.appendFileSync(historyPath, JSON.stringify(plan.appends[0]).slice(0, 24));
          io.err('simulated crash in the middle of writing compensations');
          return 2;
        }
        applyRepair(historyPath, plan);
        io.out(JSON.stringify(plan.report, null, args.pretty ? 2 : 0));
        return 0;
      }
      default:
        io.err('usage: node cli.js <append|judge|repair> [--history f] [--config f] [--op id]... [--data json] [--pretty]');
        return 1;
    }
  } catch (e) {
    io.err(`error: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
