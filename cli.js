#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Ledger } = require('./src/ledger');
const { LedgerError } = require('./src/errors');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function errorBody(err) {
  return err instanceof LedgerError
    ? err.toJSON()
    : { error: { code: 'E_INTERNAL', message: String(err && err.message ? err.message : err) } };
}

// Runs one CLI command. Returns the process exit code. `io` and `deps` are
// injectable so the CLI can be driven in-process (e.g. from tests); a
// simulated crash exit is signalled by throwing an error with isCrashExit.
function run(argv, io = process, deps = {}) {
  try {
    const args = parseArgs(argv);
    const command = args._[0];
    const walPath = args.wal || process.env.LEDGER_WAL || path.join(process.cwd(), 'ledger.wal');

    if (!command) {
      throw new LedgerError('E_INVALID_ARGS', 'usage: cli.js [--wal PATH] <pay|cancel|audit|recover|crash> [options]');
    }

    switch (command) {
      case 'pay': {
        const ledger = new Ledger(walPath).open();
        const rec = ledger.pay({ merchant: args.merchant, amount: Number(args.amount), id: args.id });
        io.stdout.write(JSON.stringify({ ok: true, transaction: rec }) + '\n');
        return 0;
      }
      case 'cancel': {
        const ledger = new Ledger(walPath).open();
        const rec = ledger.cancel({ txnId: args.txn });
        io.stdout.write(JSON.stringify({ ok: true, reversal: rec }) + '\n');
        return 0;
      }
      case 'audit': {
        if (!args.merchant) throw new LedgerError('E_INVALID_ARGS', 'audit requires --merchant M');
        const ledger = new Ledger(walPath).open();
        io.stdout.write(JSON.stringify({ ok: true, ...ledger.audit(args.merchant) }) + '\n');
        return 0;
      }
      case 'recover': {
        const ledger = new Ledger(walPath).open();
        io.stdout.write(JSON.stringify({ ok: true, recovered: true, ...ledger.stats() }) + '\n');
        return 0;
      }
      case 'crash': {
        const point = args.point;
        if (point !== 'P1' && point !== 'P2') {
          throw new LedgerError('E_INVALID_ARGS', 'crash requires --point P1|P2');
        }
        const ledger = new Ledger(walPath, { crashPoint: point, exit: deps.exit }).open();
        ledger.pay({ merchant: args.merchant, amount: Number(args.amount), id: args.id });
        io.stdout.write(JSON.stringify({ ok: true, crashed: false }) + '\n');
        return 0;
      }
      default:
        throw new LedgerError('E_INVALID_ARGS', `unknown command: ${command}`);
    }
  } catch (err) {
    if (err && err.isCrashExit) throw err; // simulated crash: process dies here
    io.stderr.write(JSON.stringify(errorBody(err)) + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
