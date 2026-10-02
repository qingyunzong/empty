#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger } from './ledger.js';

function usage() {
  return [
    'usage:',
    '  ledger [--dir DIR] apply <file.jsonl>',
    '  ledger [--dir DIR] balance <account> [--as-of N]',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { dir: process.env.LEDGER_DIR || './ledger-data', asOf: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--as-of') args.asOf = Number(argv[++i]);
    else args.positional.push(a);
  }
  return args;
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ code, message }) + '\n');
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args.positional;
  const ledger = new Ledger(args.dir);

  if (cmd === 'apply') {
    const file = rest[0];
    if (!file) throw Object.assign(new Error('apply requires a file'), { code: 'E_USAGE' });
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const op = JSON.parse(trimmed);
      let seq;
      if (op.op === 'post') seq = ledger.post(op.id, op.account, op.amount, op.meta ?? null);
      else if (op.op === 'reverse') seq = ledger.reverse(op.id, op.reason ?? null);
      else if (op.op === 'settle') seq = ledger.settle(op.upTo);
      else throw Object.assign(new Error(`unknown op ${op.op}`), { code: 'E_USAGE' });
      process.stdout.write(JSON.stringify({ op: op.op, seq }) + '\n');
    }
  } else if (cmd === 'balance') {
    const account = rest[0];
    if (!account) throw Object.assign(new Error('balance requires an account'), { code: 'E_USAGE' });
    const bal = ledger.balance(account, args.asOf);
    process.stdout.write(JSON.stringify({ account, asOf: args.asOf ?? ledger.lastSeq, balance: bal }) + '\n');
  } else {
    throw Object.assign(new Error(usage()), { code: 'E_USAGE' });
  }
}

try {
  main();
} catch (err) {
  fail(err.code ?? 'E_INTERNAL', err.message);
}
