#!/usr/bin/env node
'use strict';

const path = require('path');
const { PlanError, execPlan, recover, modifyPlan, compensate } = require('./lib/core');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.error(`usage:
  node cli.js exec        --plan plan.json [--pumps pumps.json] --journal J --out OUT
  node cli.js recover     --journal J
  node cli.js modify-plan --journal J --plan newplan.json
  node cli.js compensate  --journal J --pump PUMP_ID --slot SLOT --dose DOSE`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  switch (cmd) {
    case 'exec': {
      const result = execPlan({
        planPath: args.plan,
        pumpsPath: args.pumps,
        journalDir: args.journal,
        outDir: args.out,
      });
      console.log(JSON.stringify({ status: 'ok', total_dose: result.totalDose, entries: result.ledger.length }));
      break;
    }
    case 'recover': {
      const result = recover({ journalDir: args.journal });
      console.log(JSON.stringify({ status: 'ok', ...result }));
      break;
    }
    case 'modify-plan': {
      const result = modifyPlan({ journalDir: args.journal, newPlanPath: args.plan });
      console.log(JSON.stringify({ status: result.rejected.length ? 'partial' : 'ok', ...result }));
      break;
    }
    case 'compensate': {
      const entry = compensate({
        journalDir: args.journal,
        pumpId: args.pump,
        slot: args.slot,
        dose: Number(args.dose),
      });
      console.log(JSON.stringify({ status: 'ok', entry }));
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof PlanError) {
    console.error(JSON.stringify({ error: err.code, message: err.message }));
    process.exit(2);
  }
  console.error(err.message || String(err));
  process.exit(1);
}
