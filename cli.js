#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  Ledger,
  verifyFile,
  buildView,
  makeProof,
  verifyProof,
} = require('./lib/ledger');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_VERIFY_FAIL = 4;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const USAGE = `usage:
  node cli.js log          --file L [--type post|correct|tombstone] --account A
                           [--amount N] [--biz-key K] [--supersedes H]
                           [--ts MS] [--biz-time MS]
  node cli.js verify       --file L
  node cli.js view         --file L [--account A]
  node cli.js proof        --file L --account A [--out proof.json]
  node cli.js verify-proof --proof proof.json [--file L | --key KEYFILE]`;

class UsageError extends Error {}

function req(args, name) {
  if (args[name] == null || args[name] === true) throw new UsageError(`missing required --${name}`);
  return args[name];
}

function optInt(args, name) {
  if (args[name] == null || args[name] === true) return undefined;
  const n = Number(args[name]);
  if (!Number.isSafeInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) throw new UsageError('missing command');

  switch (cmd) {
    case 'log': {
      const file = req(args, 'file');
      const ledger = Ledger.openOrCreate(file);
      const type = args.type || 'post';
      const op = { type, account: req(args, 'account') };
      if (args['biz-key'] != null) op.bizKey = String(args['biz-key']);
      if (type !== 'tombstone') {
        const amount = optInt(args, 'amount');
        if (amount == null) throw new UsageError('missing required --amount');
        op.amount = amount;
      }
      if (args.supersedes != null) op.supersedes = String(args.supersedes);
      if (op.bizKey == null && op.supersedes == null) {
        op.bizKey = `cli-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      }
      const entry = ledger.append(op, { ts: optInt(args, 'ts'), bizTime: optInt(args, 'biz-time') });
      console.log(JSON.stringify({ seq: entry.seq, hash: entry.hash, prevHash: entry.prevHash }));
      return EXIT_OK;
    }

    case 'verify': {
      const file = req(args, 'file');
      const res = verifyFile(file);
      console.log(JSON.stringify(res));
      return res.ok ? EXIT_OK : EXIT_VERIFY_FAIL;
    }

    case 'view': {
      const file = req(args, 'file');
      const ledger = Ledger.open(file);
      const view = buildView(ledger.entries);
      if (args.account != null) {
        const acc = view.accounts[args.account];
        console.log(JSON.stringify(acc == null ? null : { [args.account]: acc }, null, 2));
      } else {
        console.log(JSON.stringify(view, null, 2));
      }
      return EXIT_OK;
    }

    case 'proof': {
      const file = req(args, 'file');
      const account = req(args, 'account');
      const ledger = Ledger.open(file);
      if (ledger.entries.length === 0) throw new UsageError('log is empty');
      const proof = makeProof(ledger.entries, account);
      const out = JSON.stringify(proof, null, 2);
      if (args.out != null && args.out !== true) {
        fs.writeFileSync(String(args.out), out + '\n');
        console.log(JSON.stringify({ wrote: String(args.out), account, entries: proof.entries.length }));
      } else {
        console.log(out);
      }
      return EXIT_OK;
    }

    case 'verify-proof': {
      const proofPath = req(args, 'proof');
      const proof = JSON.parse(fs.readFileSync(String(proofPath), 'utf8'));
      let key;
      let headHash;
      if (args.file != null && args.file !== true) {
        const ledger = Ledger.open(String(args.file));
        key = ledger.key;
        headHash = ledger.head ? ledger.head.hash : null;
      } else if (args.key != null && args.key !== true) {
        key = Buffer.from(fs.readFileSync(String(args.key), 'utf8').trim(), 'hex');
      } else {
        throw new UsageError('verify-proof needs --file L (cross-checks head) or --key KEYFILE');
      }
      const res = verifyProof(proof, key, { headHash });
      console.log(JSON.stringify(res));
      return res.ok ? EXIT_OK : EXIT_VERIFY_FAIL;
    }

    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`error: ${e.message}`);
    console.error(USAGE);
    process.exitCode = EXIT_USAGE;
  } else {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
