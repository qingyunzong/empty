#!/usr/bin/env node
'use strict';

const { Ledger } = require('./lib/ledger');
const { TxLogError } = require('./lib/store');

const EXIT_BY_CODE = {
  CONFLICT: 1,
  FORK: 2,
  CORRUPT: 2,
  INCOMPLETE: 2,
  USAGE: 64,
};

function parseArgs(argv) {
  const args = { _: [], credit: [], position: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new TxLogError('USAGE', `missing value for --${key}`);
      }
      if (key === 'credit' || key === 'position') {
        args[key].push(next);
      } else {
        args[key] = next;
      }
      i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseAccounts(creditList, positionList) {
  const accounts = {};
  const ensure = (name) => (accounts[name] = accounts[name] || {});
  for (const item of creditList) {
    const idx = item.lastIndexOf(':');
    const name = idx > 0 ? item.slice(0, idx) : '';
    const val = idx > 0 ? item.slice(idx + 1) : '';
    if (!name || !Number.isFinite(Number(val))) {
      throw new TxLogError('USAGE', `bad --credit value: ${item} (expected name:amount)`);
    }
    ensure(name).credit = Number(val);
  }
  for (const item of positionList) {
    const idx = item.lastIndexOf(':');
    const name = idx > 0 ? item.slice(0, idx) : '';
    const val = idx > 0 ? item.slice(idx + 1) : '';
    if (!name || !Number.isInteger(Number(val))) {
      throw new TxLogError('USAGE', `bad --position value: ${item} (expected name:qty)`);
    }
    ensure(name).position = Number(val);
  }
  return accounts;
}

function requireOpt(args, key) {
  if (args[key] === undefined) throw new TxLogError('USAGE', `missing --${key}`);
  return args[key];
}

function requireInt(args, key) {
  const v = Number(requireOpt(args, key));
  if (!Number.isInteger(v)) throw new TxLogError('USAGE', `--${key} must be an integer`);
  return v;
}

function requireNum(args, key) {
  const v = Number(requireOpt(args, key));
  if (!Number.isFinite(v)) throw new TxLogError('USAGE', `--${key} must be a number`);
  return v;
}

function openLedger(args) {
  const file = requireOpt(args, 'file');
  const accounts = parseAccounts(args.credit, args.position);
  return new Ledger(file, accounts);
}

function dispatch(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case 'put': {
      const ledger = openLedger(args);
      return ledger.put({
        txId: requireOpt(args, 'tx-id'),
        buyer: requireOpt(args, 'buyer'),
        seller: requireOpt(args, 'seller'),
        qty: requireInt(args, 'qty'),
        price: requireNum(args, 'price'),
      });
    }
    case 'cancel': {
      const ledger = openLedger(args);
      return ledger.cancel(requireOpt(args, 'tx-id'));
    }
    case 'replay': {
      const ledger = openLedger(args);
      return ledger.replay();
    }
    case 'range': {
      const ledger = openLedger(args);
      return ledger.range(requireInt(args, 'from'), requireInt(args, 'to'));
    }
    case 'verify': {
      const ledger = openLedger(args);
      return { ok: true, ...ledger.verify() };
    }
    default:
      throw new TxLogError('USAGE', `unknown command: ${cmd || '(none)'}; expected put|cancel|replay|range|verify`);
  }
}

// Runs one CLI invocation in-process. Returns { status, stdout, stderr }.
function run(argv) {
  try {
    const out = dispatch(argv);
    return { status: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL';
    const message = err && err.message ? err.message : String(err);
    const status = EXIT_BY_CODE[code] !== undefined ? EXIT_BY_CODE[code] : 70;
    return { status, stdout: '', stderr: JSON.stringify({ error: { code, message } }) + '\n' };
  }
}

if (require.main === module) {
  const { status, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(status);
}

module.exports = { run, EXIT_BY_CODE };
