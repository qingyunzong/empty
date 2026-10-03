#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { initLedger, mutate, restore, verify } = require('./store');
const { RejectError, CorruptError } = require('./errors');

const USAGE = `usage: cli.js <command> --file <path> [options]

commands:
  init     --total N
  freeze   --amount N
  capture  --ticket T<n> --amount N
  release  --ticket T<n>
  undo     --capture C<n>
  restore  --version N
  verify

exit codes: 0 success, 1 business rejection, 2 file corruption`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new RejectError(`unexpected argument: ${key}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RejectError(`missing value for ${key}`);
    }
    opts[key.slice(2)] = value;
    i += 1;
  }
  if (!cmd) throw new RejectError('missing command');
  if (!opts.file) throw new RejectError('missing --file');
  return { cmd, opts };
}

function toInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RejectError(`invalid ${name}: ${value}`);
  return n;
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  let out;
  switch (cmd) {
    case 'init':
      out = initLedger(opts.file, toInt(opts.total, 'total'));
      break;
    case 'freeze':
      out = mutate(opts.file, { op: 'freeze', amount: toInt(opts.amount, 'amount') });
      break;
    case 'capture':
      out = mutate(opts.file, {
        op: 'capture',
        ticketId: opts.ticket,
        amount: toInt(opts.amount, 'amount'),
      });
      break;
    case 'release':
      out = mutate(opts.file, { op: 'release', ticketId: opts.ticket });
      break;
    case 'undo':
      out = mutate(opts.file, { op: 'undo', captureId: opts.capture });
      break;
    case 'restore':
      out = restore(opts.file, toInt(opts.version, 'version'));
      break;
    case 'verify':
      out = verify(opts.file);
      break;
    default:
      throw new RejectError(`unknown command: ${cmd}`);
  }
  fs.writeSync(1, `${JSON.stringify(out, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof RejectError) {
    fs.writeSync(2, `${JSON.stringify({ code: 'REJECTED', message: err.message })}\n`);
    process.exit(1);
  }
  if (err instanceof CorruptError) {
    fs.writeSync(2, `${JSON.stringify({ code: 'CORRUPT', message: err.message })}\n`);
    process.exit(2);
  }
  fs.writeSync(2, `${USAGE}\n`);
  fs.writeSync(2, `${String(err && err.stack ? err.stack : err)}\n`);
  process.exit(1);
}
