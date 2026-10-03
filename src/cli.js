#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { commitLayer, commitCheckpoint, restore, verify } = require('./store');
const { BusinessError, CorruptError } = require('./errors');

const EXIT_OK = 0;
const EXIT_BUSINESS = 1;
const EXIT_CORRUPT = 2;

const USAGE = `usage: node src/cli.js <cmd> <file> [options]
  cmds:    reserve | freeze | pay | revert | checkpoint | restore | verify
  tx spec: --tx credit:<acct>:<amount>[:id]
           --tx reserve:<acct>:<amount>[:id]
           --tx freeze:<acct>:<amount>[:id]
           --tx pay:<acct>:<amount>:<freezeId>[:id]
           --tx revert:<payId>[:id]
  shorthand single tx: --account A --amount N [--ref ID] [--id ID]
  restore: [--checkpoint] [--to SEQ]
exit codes: 0 success, 1 business error, 2 corruption`;

function parseArgs(argv) {
  const opts = { txs: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--tx': opts.txs.push(argv[++i]); break;
      case '--account': opts.account = argv[++i]; break;
      case '--amount': opts.amount = Number(argv[++i]); break;
      case '--ref': opts.ref = argv[++i]; break;
      case '--id': opts.id = argv[++i]; break;
      case '--to': opts.to = Number(argv[++i]); break;
      case '--checkpoint': opts.checkpoint = true; break;
      default:
        if (arg.startsWith('--')) throw new BusinessError(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  return { positional, opts };
}

function parseTxSpec(spec) {
  const parts = spec.split(':');
  const [op] = parts;
  switch (op) {
    case 'credit':
    case 'reserve':
    case 'freeze': {
      const [, account, amount, id] = parts;
      return { op, account, amount: Number(amount), ...(id ? { id } : {}) };
    }
    case 'pay': {
      const [, account, amount, ref, id] = parts;
      return { op, account, amount: Number(amount), ref, ...(id ? { id } : {}) };
    }
    case 'revert': {
      const [, ref, id] = parts;
      return { op, ref, ...(id ? { id } : {}) };
    }
    default:
      throw new BusinessError(`bad tx spec: ${spec}`);
  }
}

function buildTxs(cmd, opts) {
  if (opts.txs.length > 0) return opts.txs.map(parseTxSpec);
  if (cmd === 'revert') {
    if (!opts.ref) throw new BusinessError('revert requires --ref <payId> or --tx revert:<payId>');
    return [{ op: 'revert', ref: opts.ref, ...(opts.id ? { id: opts.id } : {}) }];
  }
  if (!opts.account || !Number.isSafeInteger(opts.amount)) {
    throw new BusinessError(`${cmd} requires --tx or --account/--amount`);
  }
  return [{
    op: cmd,
    account: opts.account,
    amount: opts.amount,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.id ? { id: opts.id } : {}),
  }];
}

function run(argv) {
  const { positional, opts } = parseArgs(argv);
  const [cmd, file] = positional;
  if (!cmd || !file) throw new BusinessError(USAGE);

  switch (cmd) {
    case 'reserve':
    case 'freeze':
    case 'pay':
    case 'revert': {
      const txs = buildTxs(cmd, opts);
      const result = commitLayer(file, cmd, txs);
      return { ok: true, seq: result.seq, offset: result.offset, hash: result.hash, state: result.state };
    }
    case 'checkpoint': {
      const result = commitCheckpoint(file);
      return { ok: true, seq: result.seq, offset: result.offset, hash: result.hash };
    }
    case 'restore': {
      const result = restore(file, { checkpoint: Boolean(opts.checkpoint), to: opts.to });
      return {
        ok: true,
        mode: opts.checkpoint ? 'checkpoint' : 'full',
        checkpointSeq: result.checkpointSeq,
        stoppedAtCorruption: result.stoppedAtCorruption,
        state: result.state,
      };
    }
    case 'verify': {
      return verify(file);
    }
    default:
      throw new BusinessError(USAGE);
  }
}

function main() {
  try {
    const out = run(process.argv.slice(2));
    fs.writeSync(1, `${JSON.stringify(out, null, 2)}\n`);
    process.exitCode = out.ok === false ? EXIT_CORRUPT : EXIT_OK;
  } catch (err) {
    if (err instanceof BusinessError || err instanceof CorruptError) {
      fs.writeSync(2, `${err.name}: ${err.message}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    fs.writeSync(2, `UnexpectedError: ${err.stack || err}\n`);
    process.exitCode = EXIT_CORRUPT;
  }
}

if (require.main === module) main();

module.exports = { run, parseTxSpec, EXIT_OK, EXIT_BUSINESS, EXIT_CORRUPT };
