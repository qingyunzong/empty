#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerError } from './src/ledger.js';
import { CorruptError } from './src/format.js';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'USAGE';
    this.block = null;
    this.exitCode = 3;
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'rebuild') { opts.rebuild = true; continue; }
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for --${key}`);
      opts[key] = v;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function parseAmount(raw) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new UsageError(`amount must be a non-negative integer, got ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`amount out of range: ${raw}`);
  return n;
}

function requireOpt(opts, name) {
  if (opts[name] === undefined) throw new UsageError(`missing --${name}`);
  return opts[name];
}

function dispatch(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new UsageError('usage: ledger <append|verify|cancel|freeze|settle|dump> [--file F] ...');
  const opts = parseArgs(rest);
  const file = opts.file ?? 'ledger.dat';
  const ledger = Ledger.open(file);

  switch (cmd) {
    case 'append': {
      const txid = requireOpt(opts, 'txid');
      const kind = requireOpt(opts, 'kind');
      if (kind !== 'credit' && kind !== 'debit') throw new UsageError(`--kind must be credit|debit, got ${kind}`);
      const amount = parseAmount(requireOpt(opts, 'amount'));
      const r = ledger.append({ txid, kind, amount });
      return { ok: true, seq: r.seq, ...ledger.dump() };
    }
    case 'cancel': {
      const r = ledger.cancel(requireOpt(opts, 'txid'));
      return { ok: true, seq: r.seq, ...ledger.dump() };
    }
    case 'freeze': {
      const r = ledger.freeze(requireOpt(opts, 'txid'));
      return { ok: true, seq: r.seq, ...ledger.dump() };
    }
    case 'settle': {
      const amount = parseAmount(requireOpt(opts, 'amount'));
      const r = ledger.settle({ txid: opts.txid, amount });
      return { ok: true, seq: r.seq, ...ledger.dump() };
    }
    case 'verify': {
      const r = ledger.verify({ rebuild: !!opts.rebuild });
      return { ok: true, blocks: r.blocks, rebuilt: !!opts.rebuild };
    }
    case 'dump':
      return { ok: true, ...ledger.dump() };
    default:
      throw new UsageError(`unknown command ${cmd}`);
  }
}

// In-process entry point: returns {code, stdout, stderr}. Exit codes:
// 0 ok, 1 business rejection, 2 corruption, 3 usage/internal error.
export function run(argv) {
  try {
    return { code: 0, stdout: `${JSON.stringify(dispatch(argv))}\n`, stderr: '' };
  } catch (err) {
    const known = err instanceof LedgerError || err instanceof CorruptError || err instanceof UsageError;
    const body = {
      ok: false,
      code: known ? err.code : 'INTERNAL',
      block: known ? err.block ?? null : null,
      message: known ? err.message : String(err && err.stack ? err.stack : err),
    };
    return { code: known ? err.exitCode : 3, stdout: '', stderr: `${JSON.stringify(body)}\n` };
  }
}

const invokedAsMain = process.argv[1]
  && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedAsMain) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
