#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const ledger = require('./src/ledger');

const EXIT_BUSINESS = 1;
const EXIT_CORRUPT = 2;
const EXIT_USAGE = 64;

function out(obj) {
  fs.writeSync(1, JSON.stringify(obj) + '\n');
}

function errOut(obj) {
  fs.writeSync(2, JSON.stringify(obj) + '\n');
}

function parseAmount(s) {
  if (!/^\d+$/.test(s)) throw new ledger.LedgerError('BAD_AMOUNT', `amount must be a positive integer: ${s}`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ledger.LedgerError('BAD_AMOUNT', `amount must be a positive integer: ${s}`);
  return n;
}

function usage() {
  errOut({
    ok: false,
    error: {
      code: 'USAGE',
      block: null,
      message:
        'usage: cli.js <append|settle|cancel|freeze|verify|dump> <file> [args]\n' +
        '  append <file> <txId> <credit|debit> <amount>\n' +
        '  settle <file> <amount>\n' +
        '  cancel <file> <txId>\n' +
        '  freeze <file> <txId>\n' +
        '  verify <file> [--rebuild]\n' +
        '  dump   <file>',
    },
  });
  process.exitCode = EXIT_USAGE;
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file) return usage();

  switch (cmd) {
    case 'append': {
      const [txId, kind, amount] = rest;
      if (!txId || (kind !== 'credit' && kind !== 'debit') || amount === undefined) return usage();
      return ledger.appendEvent(file, { type: 'append', txId, kind, amount: parseAmount(amount) });
    }
    case 'settle': {
      if (rest.length !== 1) return usage();
      return ledger.appendEvent(file, { type: 'settle', amount: parseAmount(rest[0]) });
    }
    case 'cancel': {
      if (rest.length !== 1 || !rest[0]) return usage();
      return ledger.appendEvent(file, { type: 'cancel', txId: rest[0] });
    }
    case 'freeze': {
      if (rest.length !== 1 || !rest[0]) return usage();
      return ledger.appendEvent(file, { type: 'freeze', txId: rest[0] });
    }
    case 'verify': {
      const result = rest.includes('--rebuild') ? ledger.rebuild(file) : ledger.verify(file);
      if (!result.ok) {
        errOut({ ok: false, error: result.error });
        process.exitCode = EXIT_CORRUPT;
        return null;
      }
      return result;
    }
    case 'dump': {
      const { state, blocks } = ledger.decodeState(file);
      return { ok: true, blocks, state: ledger.withAvailable(state) };
    }
    default:
      return usage();
  }
}

try {
  const result = main(process.argv.slice(2));
  if (result && result.ok === false) {
    errOut(result);
    process.exitCode = EXIT_BUSINESS;
  } else if (result) {
    out(result);
  }
} catch (e) {
  if (e instanceof ledger.LedgerError) {
    errOut({ ok: false, error: { code: e.code, block: e.block, message: e.message } });
    process.exitCode =
      e.code.startsWith('CORRUPT') || e.code === 'NO_INDEX' || e.code === 'STALE_INDEX'
        ? EXIT_CORRUPT
        : EXIT_BUSINESS;
  } else {
    errOut({ ok: false, error: { code: 'INTERNAL', block: null, message: e.message } });
    process.exitCode = EXIT_BUSINESS;
  }
}
