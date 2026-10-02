#!/usr/bin/env node
'use strict';

const { Ledger, BizError } = require('./lib/ledger');

class UsageError extends Error {}

const USAGE = `Usage: node cli.js [--dir PATH] <command> [args]

Commands:
  freeze <account> <budget>        Create an account or set its total budget
  enqueue <id> <account> <amount>  Queue a payment, freezing amount against the
                                   account budget (repeat enqueue is idempotent)
  cancel <id>                      Cancel a queued payment, releasing its freeze
  settle                           Select the maximal fully-settlable set of
                                   queued payments and commit a settlement block
  refund <id>                      Refund a settled payment via a reverse block
                                   referencing the original settlement hash
  batch [n]                        List the confirmed block index, or decode batch n
  verify                           Verify chain integrity (CRC32, hashes, index)
  recover                          Admit orphaned block bodies after a crash and
                                   patch the index (stops at the first bad block)

Ledger directory defaults to $LEDGER_DIR or ./ledger.
Exit codes: 0 success, 1 business/verification failure, 2 usage or I/O error.`;

function parseCli(argv) {
  const opts = { dir: process.env.LEDGER_DIR || './ledger' };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a === '-d') {
      if (i + 1 >= argv.length) throw new UsageError(`${a} requires a path`);
      opts.dir = argv[++i];
    } else if (a.startsWith('--dir=')) {
      opts.dir = a.slice('--dir='.length);
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

function parseIntArg(s, name) {
  if (!/^-?\d+$/.test(s)) throw new UsageError(`${name} must be an integer, got: ${s}`);
  const v = Number(s);
  if (!Number.isSafeInteger(v)) throw new UsageError(`${name} out of range: ${s}`);
  return v;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function run(pos, opts) {
  const cmd = pos[0];
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (!cmd) throw new UsageError('missing command');
  const ledger = new Ledger(opts.dir);
  switch (cmd) {
    case 'freeze': {
      if (pos.length !== 3) throw new UsageError('freeze <account> <budget>');
      print(ledger.freeze(pos[1], parseIntArg(pos[2], 'budget')));
      return 0;
    }
    case 'enqueue': {
      if (pos.length !== 4) throw new UsageError('enqueue <id> <account> <amount>');
      print(ledger.enqueue(pos[1], pos[2], parseIntArg(pos[3], 'amount')));
      return 0;
    }
    case 'cancel': {
      if (pos.length !== 2) throw new UsageError('cancel <id>');
      print(ledger.cancel(pos[1]));
      return 0;
    }
    case 'settle': {
      if (pos.length !== 1) throw new UsageError('settle takes no arguments');
      const r = ledger.settle();
      print({
        batch: r.batch,
        hash: r.hash,
        selected: r.body.deltas.map((d) => d.id),
        rejected: r.body.rejected,
      });
      return 0;
    }
    case 'refund': {
      if (pos.length !== 2) throw new UsageError('refund <id>');
      print(ledger.refund(pos[1]));
      return 0;
    }
    case 'batch': {
      if (pos.length === 1) {
        const batches = ledger.index.batches.map((e) => {
          const body = ledger.getBatch(e.batch);
          return {
            batch: e.batch,
            hash: e.hash,
            type: body.type,
            deltas: body.deltas.length,
            rejected: body.rejected.length,
          };
        });
        print({ batches });
        return 0;
      }
      if (pos.length === 2) {
        print(ledger.getBatch(parseIntArg(pos[1], 'batch')));
        return 0;
      }
      throw new UsageError('batch [n]');
    }
    case 'verify': {
      if (pos.length !== 1) throw new UsageError('verify takes no arguments');
      const r = ledger.verify();
      print(r);
      return r.ok ? 0 : 1;
    }
    case 'recover': {
      if (pos.length !== 1) throw new UsageError('recover takes no arguments');
      const r = ledger.recover();
      print(r);
      return r.failed ? 1 : 0;
    }
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

function main() {
  try {
    const { opts, pos } = parseCli(process.argv.slice(2));
    process.exitCode = run(pos, opts);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(e.message + '\n\n' + USAGE + '\n');
      process.exitCode = 2;
    } else if (e instanceof BizError) {
      process.stderr.write('error: ' + e.message + '\n');
      process.exitCode = 1;
    } else {
      process.stderr.write((e && e.stack ? e.stack : String(e)) + '\n');
      process.exitCode = 2;
    }
  }
}

main();
