#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Ledger, LedgerError, CrashError } = require('./src/ledger');

const USAGE = `usage: node cli.js <dir> <command> [args] [--key K] [--crash-after intent|apply|commit]

commands:
  open <account> <balance>     create account with initial balance
  freeze <account> <amount>    move amount from available to frozen
  debit <account> <amount>     capture amount out of frozen (balance and frozen decrease)
  release <account> <amount>   move amount from frozen back to available
  reverse <targetKey>          compensate a committed transaction (冲正)
  balance [account]            show one or all accounts
  recover                      show the recovery report produced on open
  pending                      list PENDING (retryable) idempotency keys
  wal                          dump raw WAL records
`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else {
        flags[arg.slice(2)] = argv[i + 1];
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [dir, command, ...rest] = positional;
  if (!dir || !command) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const key = flags.key || randomUUID();
  const ledger = new Ledger(dir, { crashAfter: flags['crash-after'] || null });
  try {
    let out;
    switch (command) {
      case 'open':
        out = ledger.transact({ key, op: 'open', account: rest[0], amount: Number(rest[1]) });
        break;
      case 'freeze':
      case 'debit':
      case 'release':
        out = ledger.transact({ key, op: command, account: rest[0], amount: Number(rest[1]) });
        break;
      case 'reverse':
        out = ledger.transact({ key, op: 'reverse', target: rest[0] });
        break;
      case 'balance':
        out = rest[0] ? ledger.balanceOf(rest[0]) : ledger.snapshot();
        break;
      case 'recover':
        out = ledger.recoveryReport;
        break;
      case 'pending':
        out = ledger.pending();
        break;
      case 'wal':
        out = fs
          .readFileSync(ledger.walPath, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
        break;
      default:
        process.stderr.write(USAGE);
        process.exit(2);
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  } finally {
    ledger.close();
  }
}

try {
  main();
} catch (err) {
  if (err instanceof CrashError) {
    process.stderr.write(JSON.stringify({ crash: err.point }) + '\n');
    process.exit(70);
  }
  if (err instanceof LedgerError) {
    process.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
    process.exit(1);
  }
  throw err;
}
