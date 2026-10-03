#!/usr/bin/env node
'use strict';

const { Store } = require('./src/store');
const { StoreError } = require('./src/errors');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

const USAGE = [
  'usage:',
  '  node cli.js create-account --db DIR --id ID --balance N',
  '  node cli.js debit          --db DIR --id ID --amount N [--resource R] [--units N]',
  '  node cli.js balance        --db DIR --id ID',
  '  node cli.js usage          --db DIR [--id ID]',
  '  node cli.js history        --db DIR [--id ID]',
  '',
].join('\n');

// Runs one CLI command in-process. Returns { code, stdout, stderr } so it can
// be driven both by the executable wrapper below and directly by tests.
async function run(argv) {
  const out = { code: 0, stdout: '', stderr: '' };
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || !args.db) {
    out.code = 2;
    out.stderr = USAGE;
    return out;
  }

  const store = Store.open(args.db);
  try {
    switch (command) {
      case 'create-account': {
        const result = await store.createAccount(args.id, Number(args.balance ?? 0));
        out.stdout = JSON.stringify({ ok: true, ...result }) + '\n';
        break;
      }
      case 'debit': {
        const tx = store.begin();
        tx.debit(args.id, Number(args.amount), {
          resource: args.resource ?? null,
          units: args.units ? Number(args.units) : undefined,
        });
        const result = await tx.commit();
        out.stdout = JSON.stringify({ ok: true, ...result }) + '\n';
        break;
      }
      case 'balance': {
        out.stdout = JSON.stringify({ account: args.id, balance: store.balanceOf(args.id) }) + '\n';
        break;
      }
      case 'usage': {
        out.stdout = JSON.stringify({ usage: store.usageOf(args.id ?? null) }) + '\n';
        break;
      }
      case 'history': {
        out.stdout = JSON.stringify({ history: store.getHistory(args.id ?? null) }) + '\n';
        break;
      }
      default:
        out.code = 2;
        out.stderr = USAGE;
    }
  } catch (err) {
    out.code = 1;
    if (err instanceof StoreError) {
      out.stderr = JSON.stringify({ error: err.code, message: err.message, retryable: err.retryable }) + '\n';
    } else {
      out.stderr = JSON.stringify({ error: 'INTERNAL', message: String((err && err.message) || err) }) + '\n';
    }
  } finally {
    store.close();
  }
  return out;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.code);
  });
}

module.exports = { run };
