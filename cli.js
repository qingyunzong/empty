#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { BusinessError, CorruptError } from './src/errors.js';

const USAGE = `usage: node cli.js <command> [options] [--file PATH]

commands:
  init     --total N
  freeze   --amount N
  capture  --ticket ID --amount N
  release  --ticket ID
  undo     --op OP_ID
  restore  --version N
  verify

exit codes: 0 ok, 1 business rejection, 2 file corruption`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new BusinessError(`unexpected argument: ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[++i];
  }
  return { cmd, opts };
}

function num(opts, key) {
  const value = Number(opts[key]);
  if (!Number.isInteger(value)) throw new BusinessError(`--${key} must be an integer`);
  return value;
}

function dispatch(cmd, opts) {
  const store = new Store(opts.file || 'ledger.bin');
  switch (cmd) {
    case 'init':
      return store.init(num(opts, 'total'));
    case 'freeze':
      return store.appendOp({ type: 'freeze', amount: num(opts, 'amount') });
    case 'capture':
      return store.appendOp({ type: 'capture', ticketId: opts.ticket, amount: num(opts, 'amount') });
    case 'release':
      return store.appendOp({ type: 'release', ticketId: opts.ticket });
    case 'undo':
      return store.appendOp({ type: 'undo', opId: opts.op });
    case 'restore':
      return store.restore(num(opts, 'version'));
    case 'verify':
      return store.verify();
    default:
      throw new BusinessError(cmd ? `unknown command: ${cmd}` : `missing command\n${USAGE}`);
  }
}

// Runs one CLI invocation. Returns the exit code (0 ok, 1 rejected, 2 corrupt)
// and writes JSON to io.stdout / io.stderr. Exported for in-process testing.
export function runCli(argv, io = {}) {
  const out = io.stdout || ((s) => process.stdout.write(s));
  const err = io.stderr || ((s) => process.stderr.write(s));
  try {
    const { cmd, opts } = parseArgs(argv);
    const result = dispatch(cmd, opts);
    out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err2) {
    const code = err2 instanceof BusinessError ? 'REJECTED' : 'CORRUPT';
    err(`${JSON.stringify({ code, error: err2.message })}\n`);
    return err2 instanceof BusinessError ? 1 : 2;
  }
}

const invokedAs = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedAs && fileURLToPath(import.meta.url) === invokedAs) {
  process.exitCode = runCli(process.argv.slice(2));
}
