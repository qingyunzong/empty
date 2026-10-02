#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { appendOp, readHistory, DEFAULT_HISTORY } = require('./src/history');
const { judge } = require('./src/judge');
const { repair, SimulatedCrash } = require('./src/repair');
const { CODE_NAMES } = require('./src/sim');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadConfig(args) {
  if (!args.config) return {};
  return JSON.parse(fs.readFileSync(args.config, 'utf8'));
}

function fail(message, code) {
  process.stdout.write(JSON.stringify({ error: message, code, reason: CODE_NAMES[code] }) + '\n');
  process.exit(1);
}

const USAGE = `usage:
  node cli.js append --history f --account A --type freeze|hold|release --amount N
                     [--ref OPID] [--day YYYY-MM-DD] [--ts N] [--causes a,b] [--opId ID]
  node cli.js judge  [--history f] [--config c.json] [--account A] [--max-ties N]
  node cli.js repair [--history f] [--config c.json] [--crash-after N]
  node cli.js show   [--history f]`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const historyFile = args.history || DEFAULT_HISTORY;

  if (cmd === 'append') {
    for (const k of ['account', 'type', 'amount']) {
      if (args[k] == null) fail(`missing --${k}`, 15);
    }
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) fail('amount must be a positive number', 15);
    const op = {
      account: args.account,
      type: args.type,
      amount,
    };
    if (args.opId != null) op.opId = args.opId;
    if (args.ref != null) op.ref = args.ref;
    if (args.day != null) op.day = args.day;
    if (args.ts != null) op.ts = Number(args.ts);
    if (args.causes != null) op.causes = String(args.causes).split(',').filter(Boolean);
    try {
      const stored = appendOp(historyFile, op);
      process.stdout.write(JSON.stringify({ appended: stored }) + '\n');
    } catch (err) {
      fail(err.message, err.code || 15);
    }
    return;
  }

  if (cmd === 'judge') {
    const config = loadConfig(args);
    const opts = {};
    if (args['max-ties'] != null) opts.maxTies = Number(args['max-ties']);
    const result = judge(readHistory(historyFile), config, opts);
    if (args.account) {
      const acc = result.accounts[args.account];
      process.stdout.write(JSON.stringify({ accounts: acc ? { [args.account]: acc } : {} }, null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    return;
  }

  if (cmd === 'repair') {
    const config = loadConfig(args);
    const opts = {};
    if (args['crash-after'] != null) opts.crashAfterWrites = Number(args['crash-after']);
    try {
      const summary = repair(historyFile, config, opts);
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    } catch (err) {
      if (err instanceof SimulatedCrash) {
        process.stdout.write(JSON.stringify({ crashed: true, addedBeforeCrash: err.added }, null, 2) + '\n');
        process.exit(2);
      }
      throw err;
    }
    return;
  }

  if (cmd === 'show') {
    process.stdout.write(JSON.stringify(readHistory(historyFile), null, 2) + '\n');
    return;
  }

  process.stderr.write(USAGE + '\n');
  process.exit(cmd == null ? 0 : 64);
}

main();
