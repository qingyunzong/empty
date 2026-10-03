#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Ledger, LedgerError } = require('./src/ledger');

const USAGE = `usage: ledger [--dir <path>] <command> [args]

commands:
  init                                  create a new ledger
  append <tx.json>                      append a transaction (tx.parent must equal current head)
  reverse <txId>                        append a compensating REVERSAL for txId
  rewrite --keep-published <anchorHash> [--drop <txId>...]
                                        rewrite the unpublished suffix after anchorHash
  verify                                check hash-chain integrity
  balance                               print per-account net totals

env:
  LEDGER_DIR        ledger directory (default ./.ledger)
  LEDGER_FAIL_AT    fault injection point: tmp | rename | head (testing only)
`;

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function main(argv) {
  const args = [...argv];
  let dir = process.env.LEDGER_DIR || '.ledger';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') {
      if (i + 1 >= args.length) throw new LedgerError('USAGE', 2, '--dir requires a value');
      dir = args[i + 1];
      args.splice(i, 2);
      i--;
    }
  }
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'init': {
      Ledger.init(dir);
      out({ ok: true, dir });
      return;
    }
    case 'append': {
      const file = rest[0];
      if (!file) throw new LedgerError('USAGE', 2, 'append requires a tx.json file');
      let tx;
      try {
        tx = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new LedgerError('INVALID_TX', 2, `cannot read tx json: ${err.message}`);
      }
      const head = Ledger.open(dir).append(tx);
      out({ ok: true, head });
      return;
    }
    case 'reverse': {
      const txId = rest[0];
      if (!txId) throw new LedgerError('USAGE', 2, 'reverse requires a txId');
      const head = Ledger.open(dir).reverse(txId);
      out({ ok: true, head });
      return;
    }
    case 'rewrite': {
      let anchor = null;
      const drop = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--keep-published') {
          anchor = rest[++i];
        } else if (rest[i] === '--drop') {
          if (i + 1 >= rest.length) throw new LedgerError('USAGE', 2, '--drop requires a txId');
          drop.push(rest[++i]);
        } else {
          throw new LedgerError('USAGE', 2, `unknown rewrite option ${rest[i]}`);
        }
      }
      if (!anchor) throw new LedgerError('USAGE', 2, 'rewrite requires --keep-published <anchorHash>');
      const head = Ledger.open(dir).rewrite({ anchor, drop });
      out({ ok: true, head });
      return;
    }
    case 'verify': {
      out(Ledger.open(dir).verify());
      return;
    }
    case 'balance': {
      out({ ok: true, balances: Ledger.open(dir).balances() });
      return;
    }
    default:
      throw new LedgerError('USAGE', 2, `unknown command ${cmd ?? ''}\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const code = err instanceof LedgerError ? err.code : 'INTERNAL';
  const exitCode = err instanceof LedgerError ? err.exitCode : 1;
  process.stderr.write(JSON.stringify({ error: { code, message: err.message } }) + '\n');
  process.exit(exitCode);
}
