#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger, LedgerError } from '../src/ledger.js';

const USAGE = `usage: ledger [--dir <path>] <command> [args]

commands:
  init                                 create ledger directory
  append <tx.json>                     validate parent and append a transaction
  reverse <txId>                       append a compensating REVERSAL transaction
  rewrite --keep-published <hash>      rewrite unpublished suffix, keep prefix
  verify                               validate the hash chain and report totals

environment:
  LEDGER_DIR        default ledger directory (overridden by --dir)
  LEDGER_FAULT      fault injection: tmp-write | rename | head-update`;

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const dir = options.dir ?? process.env.LEDGER_DIR ?? '.ledger';
  const [command, ...rest] = positional;
  let result;
  switch (command) {
    case 'init': {
      const ledger = Ledger.init(dir);
      result = { ok: true, dir: ledger.dir };
      break;
    }
    case 'append': {
      const file = rest[0];
      if (!file) throw new LedgerError('USAGE', 'append requires a <tx.json> path');
      let input;
      try {
        input = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new LedgerError('INVALID_JSON', `cannot read ${file}: ${error.message}`);
      }
      const { hash, tx } = new Ledger(dir).append(input);
      result = { ok: true, hash, tx };
      break;
    }
    case 'reverse': {
      const txId = rest[0];
      if (!txId) throw new LedgerError('USAGE', 'reverse requires a <txId>');
      const { hash, tx } = new Ledger(dir).reverse(txId);
      result = { ok: true, hash, tx };
      break;
    }
    case 'rewrite': {
      const anchor = options['keep-published'];
      if (!anchor || anchor === true) {
        throw new LedgerError('USAGE', 'rewrite requires --keep-published <anchorHash>');
      }
      result = { ok: true, ...new Ledger(dir).rewrite(anchor) };
      break;
    }
    case 'verify': {
      result = new Ledger(dir).verify();
      break;
    }
    default:
      throw new LedgerError('USAGE', USAGE);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

try {
  main();
} catch (error) {
  const isLedgerError = error instanceof LedgerError;
  const body = {
    error: {
      code: isLedgerError ? error.code : 'INTERNAL',
      message: error.message,
    },
  };
  process.stderr.write(JSON.stringify(body) + '\n');
  process.exit(isLedgerError ? error.exitCode : 1);
}
