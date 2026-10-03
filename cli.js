#!/usr/bin/env node
'use strict';

const { Ledger, SimulatedCrashError } = require('./src/ledger');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const dir = opts.dir || './ledger-data';
  if (!command) throw new Error('usage: cli.js [--dir DIR] <command> [options]');

  const ledger = new Ledger(dir);

  switch (command) {
    case 'pay': {
      const version = ledger.pay({
        txId: opts.tx,
        from: opts.from,
        to: opts.to,
        amount: Number(opts.amount),
      });
      print({ ok: true, tx: opts.tx, version });
      break;
    }
    case 'cancel': {
      const version = ledger.cancel({ txId: opts.tx });
      print({ ok: true, tx: opts.tx, version });
      break;
    }
    case 'begin-snapshot': {
      const snap = ledger.beginSnapshot(opts.id);
      print({ ok: true, snapshot: snap.id, version: snap.version });
      break;
    }
    case 'end-snapshot': {
      ledger.endSnapshot(opts.id);
      print({ ok: true, snapshot: opts.id });
      break;
    }
    case 'get': {
      if (opts.tx) {
        print({ ok: true, tx: ledger.getTx(opts.tx) });
      } else {
        const at = opts.at === undefined ? undefined : Number(opts.at);
        print({
          ok: true,
          account: opts.account,
          at: at === undefined ? ledger.version : at,
          balance: ledger.balanceAt(opts.account, at),
        });
      }
      break;
    }
    case 'checkpoint': {
      const seq = ledger.checkpoint();
      print({ ok: true, checkpoint: seq, watermark: ledger.version });
      break;
    }
    case 'crash': {
      if (opts.point !== 'C1' && opts.point !== 'C2') {
        throw new Error('crash --point must be C1 or C2');
      }
      try {
        ledger.checkpoint({ crashPoint: opts.point });
      } catch (err) {
        if (err instanceof SimulatedCrashError) {
          process.stderr.write(`simulated crash at ${err.point}\n`);
          process.exit(70);
        }
        throw err;
      }
      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
