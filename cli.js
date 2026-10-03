#!/usr/bin/env node
'use strict';
// Usage: node cli.js log|verify|view|proof|verify-proof [options]
const fs = require('fs');
const { parseArgs } = require('node:util');
const ledger = require('./lib/ledger');

const cmd = process.argv[2];
const { values: args } = parseArgs({
  args: process.argv.slice(3),
  options: {
    log: { type: 'string' },
    idx: { type: 'string' },
    key: { type: 'string' },
    op: { type: 'string' },
    'business-time': { type: 'string' },
    'log-time': { type: 'string' },
    supersedes: { type: 'string' },
    account: { type: 'string' },
    out: { type: 'string' },
    proof: { type: 'string' },
  },
});

const logPath = args.log || 'ledger.log';
const idxPath = args.idx || logPath + '.idx';
const keyPath = args.key || logPath + '.key';

function out(msg) { fs.writeSync(1, msg + '\n'); }
function die(msg, code) {
  fs.writeSync(2, msg + '\n');
  process.exitCode = code;
}

switch (cmd) {
  case 'log': {
    if (!args.op) die('log: --op <json> required', 1);
    const op = JSON.parse(args.op);
    const opts = {};
    if (args['business-time']) opts.businessTime = Number(args['business-time']);
    if (args['log-time']) opts.logTime = Number(args['log-time']);
    if (args.supersedes !== undefined) opts.supersedes = Number(args.supersedes);
    try {
      const entry = ledger.appendEntry(logPath, idxPath, keyPath, op, opts);
      out(JSON.stringify(entry));
    } catch (e) {
      die('log: ' + e.message, 1);
    }
    break;
  }
  case 'verify': {
    ledger.recover(logPath, idxPath);
    const res = ledger.verify(logPath, keyPath);
    if (res.ok) {
      out(`OK ${res.count} entries verified, tip ${res.tip}`);
    } else {
      out(`FAIL entry ${res.index} offset ${res.offset}: ${res.reason}`);
      process.exitCode = 4;
    }
    break;
  }
  case 'view': {
    ledger.recover(logPath, idxPath);
    const view = ledger.buildView(logPath);
    if (args.account) {
      out(JSON.stringify({
        account: args.account,
        balance: view.accounts[args.account] || 0,
        conflicts: view.conflicts.filter((c) => c.account === args.account),
      }));
    } else {
      out(JSON.stringify(view, null, 2));
    }
    break;
  }
  case 'proof': {
    if (!args.account) die('proof: --account required', 1);
    ledger.recover(logPath, idxPath);
    const proof = ledger.buildProof(logPath, args.account);
    const json = JSON.stringify(proof, null, 2);
    if (args.out) {
      fs.writeFileSync(args.out, json + '\n');
      out(`proof written to ${args.out} (${proof.entries.length} entries, ${proof.ancestors.length} ancestors)`);
    } else {
      out(json);
    }
    break;
  }
  case 'verify-proof': {
    if (!args.proof) die('verify-proof: --proof <file> required', 1);
    ledger.recover(logPath, idxPath);
    const proof = JSON.parse(fs.readFileSync(args.proof, 'utf8'));
    const res = ledger.verifyProof(logPath, keyPath, proof);
    if (res.ok) {
      out(`OK proof for ${res.account}: ${res.entries} entries, ${res.ancestors} ancestors recomputed`);
    } else {
      out('FAIL ' + res.reason);
      process.exitCode = 5;
    }
    break;
  }
  default:
    die('usage: node cli.js log|verify|view|proof|verify-proof [options]', 1);
}
