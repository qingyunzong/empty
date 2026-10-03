#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const csv = require('./lib/csv');
const { reconcile } = require('./lib/reconcile');
const { rollbackBatch } = require('./lib/rollback');
const budget = require('./lib/budget');
const { Store } = require('./lib/store');
const { ReconError } = require('./lib/errors');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[key] = argv[++i];
      } else {
        opts[key] = 'true';
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function readCsv(file) {
  return csv.parse(fs.readFileSync(file, 'utf8'));
}

function cmdReconcile(args) {
  const windowSec = args.window !== undefined ? Number(args.window) : 86400;
  const result = reconcile({
    channels: readCsv(args.channels),
    clearing: readCsv(args.clearing),
    bank: readCsv(args.bank),
    windowSec,
  });
  const outDir = args.out || '.';
  fs.mkdirSync(outDir, { recursive: true });

  const matchedRows = [];
  const unmatchedRows = [];
  const pairs = [
    ['channel-clearing', result.channelClearing, 'channel', 'clearing'],
    ['clearing-bank', result.clearingBank, 'clearing', 'bank'],
  ];
  for (const [pairName, pair, leftName, rightName] of pairs) {
    for (const m of pair.matched) {
      matchedRows.push({
        pair: pairName,
        left: m.left.join('+'),
        right: m.right.join('+'),
        amount: m.amount,
        currency: m.currency,
        alternatives: m.alternatives.map((alt) => (Array.isArray(alt) ? alt.join('+') : alt)).join(';'),
      });
    }
    for (const id of pair.unmatchedLeft) unmatchedRows.push({ pair: pairName, side: leftName, id });
    for (const id of pair.unmatchedRight) unmatchedRows.push({ pair: pairName, side: rightName, id });
    console.log(
      `${pairName}: matched=${pair.matched.length} unmatched_${leftName}=${pair.unmatchedLeft.length} unmatched_${rightName}=${pair.unmatchedRight.length}`
    );
  }
  fs.writeFileSync(path.join(outDir, 'matched.csv'), csv.stringify(matchedRows, ['pair', 'left', 'right', 'amount', 'currency', 'alternatives']));
  fs.writeFileSync(path.join(outDir, 'unmatched.csv'), csv.stringify(unmatchedRows, ['pair', 'side', 'id']));
  console.log(`wrote ${path.join(outDir, 'matched.csv')} and ${path.join(outDir, 'unmatched.csv')}`);
}

function cmdRollback(args) {
  const store = new Store(args.data || '.').load();
  const result = rollbackBatch(store, args.batch, { failAfter: args['fail-after'] });
  console.log(`rolled_back: ${result.rolledBack.join(',') || '(none)'}`);
  for (const adj of result.adjustments) {
    console.log(`reversal_adjustment: ${adj.batchId} parent=${adj.parentId} amount=${adj.amount} ${adj.currency}`);
  }
}

function cmdBudget(args) {
  const store = new Store(args.data || '.').load();
  const sub = args._[1];
  if (sub === 'set') {
    budget.setLimit(store.budgets, args.customer, args.date, Number(args.limit));
    store.saveBudgets();
    console.log(`limit set: customer=${args.customer} date=${args.date} limit=${args.limit}`);
  } else if (sub === 'apply') {
    const res = budget.applyBatch(store, args.batch, { failAfter: args['fail-after'] });
    console.log(`applied=${res.applied} net=${res.net}`);
  } else if (sub === 'check') {
    const net = budget.usageOf(store.budgets, args.customer, args.date);
    const limit = budget.limitOf(store.budgets, args.customer, args.date);
    const limitText = limit === Infinity ? 'unlimited' : String(limit);
    const status = net <= limit ? 'ok' : 'exceeded';
    console.log(`customer=${args.customer} date=${args.date} net=${net} limit=${limitText} status=${status}`);
  } else {
    throw new ReconError(2, `unknown budget subcommand: ${sub}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'reconcile') return cmdReconcile(args);
  if (cmd === 'rollback') return cmdRollback(args);
  if (cmd === 'budget') return cmdBudget(args);
  throw new ReconError(2, `unknown command: ${cmd}. usage: node cli.js reconcile|rollback|budget`);
}

try {
  main();
} catch (err) {
  if (err instanceof ReconError) {
    console.error(`error code=${err.code} ${err.message}`);
    process.exit(err.code);
  }
  console.error(`error code=1 ${err.message}`);
  process.exit(1);
}
