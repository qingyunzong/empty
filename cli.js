#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  parseCsv, loadState, saveState, reconcile, rollback,
  loadIntoState, setLimit, getNet, getLimit, toCents, ReconError,
} = require('./src');

function opt(args, name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

function readCsv(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

function readCsvSets(args) {
  return {
    channel: opt(args, 'channel') ? readCsv(opt(args, 'channel')) : [],
    clearing: opt(args, 'clearing') ? readCsv(opt(args, 'clearing')) : [],
    bank: opt(args, 'bank') ? readCsv(opt(args, 'bank')) : [],
  };
}

// Returns the process exit code; output goes through the injected writers.
function runCli(argv, io = {}) {
  const out = io.stdout || ((s) => console.log(s));
  const err = io.stderr || ((s) => console.error(s));
  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case 'reconcile': {
        const result = reconcile(readCsvSets(args), {
          windowSec: Number(opt(args, 'window', 300)),
        });
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'load': {
        const stateFile = opt(args, 'state', 'state.json');
        const state = loadState(stateFile);
        const summary = loadIntoState(state, readCsvSets(args));
        saveState(stateFile, state);
        out(JSON.stringify({ stateFile, ...summary }));
        return 0;
      }
      case 'rollback': {
        const stateFile = opt(args, 'state', 'state.json');
        const batchId = opt(args, 'batch');
        if (!batchId) throw new ReconError(1, 'missing --batch');
        const state = loadState(stateFile);
        const result = rollback(state, batchId, {
          persist: (s) => saveState(stateFile, s),
          crashAfterBudget: opt(args, 'crash-after-budget') === '1',
        });
        out(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'budget': {
        const stateFile = opt(args, 'state', 'state.json');
        const customer = opt(args, 'customer');
        const date = opt(args, 'date');
        if (!customer || !date) throw new ReconError(1, 'missing --customer/--date');
        const state = loadState(stateFile);
        if (opt(args, 'limit') !== undefined) {
          setLimit(state, customer, date, toCents(opt(args, 'limit')));
          saveState(stateFile, state);
        }
        const limit = getLimit(state, customer, date);
        out(JSON.stringify({
          customerId: customer, date, unit: 'cents',
          net: getNet(state, customer, date),
          limit: limit === Infinity ? null : limit,
        }));
        return 0;
      }
      default:
        err('usage: node cli.js reconcile|load|rollback|budget [options]');
        return 2;
    }
  } catch (e) {
    const code = typeof e.code === 'number' ? e.code : 1;
    err(JSON.stringify({ code, error: e.message, details: e.details || null }));
    return code;
  }
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}

module.exports = { runCli };
