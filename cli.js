#!/usr/bin/env node
import fs from 'node:fs';
import { Database } from './src/database.js';

// Synchronous stdout writes: console.log to a pipe can be dropped on exit.
const out = (obj) => fs.writeSync(1, JSON.stringify(obj) + '\n');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'prepared') {
        opts.prepared = true;
      } else {
        opts[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function usage() {
  return [
    'Usage:',
    '  node cli.js freeze <account> <amount> [--priority N] [--db DIR]',
    '  node cli.js cancel <freezeId> [--db DIR]',
    '  node cli.js query [account] [--db DIR]',
    '  node cli.js crash --prepared --account A --amount N [--priority P] [--db DIR]',
  ].join('\n');
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const dir = opts.db ?? '.freezedb';
  const db = new Database({ dir });

  switch (command) {
    case 'freeze': {
      const [, account, amountRaw] = positional;
      const amount = Number(amountRaw);
      const priority = opts.priority !== undefined ? Number(opts.priority) : 0;
      if (!account || !Number.isInteger(amount) || amount <= 0) throw new Error(usage());
      const freezeId = await db.transaction(async (tx) => tx.freeze(account, amount, priority));
      out({ ok: true, freezeId, account, amount, priority });
      break;
    }
    case 'cancel': {
      const [, freezeId] = positional;
      if (!freezeId) throw new Error(usage());
      await db.transaction(async (tx) => tx.cancel(freezeId));
      out({ ok: true, cancelled: freezeId });
      break;
    }
    case 'query': {
      const [, account] = positional;
      if (account) {
        const info = db.getAccount(account);
        if (!info) throw new Error(`account ${account} not found`);
        out(info);
      } else {
        out({ accounts: db.listAccounts(), freezes: db.scanByPriority() });
      }
      break;
    }
    case 'crash': {
      if (!opts.prepared) throw new Error('crash requires --prepared');
      const account = opts.account;
      const amount = Number(opts.amount);
      const priority = opts.priority !== undefined ? Number(opts.priority) : 0;
      if (!account || !Number.isInteger(amount) || amount <= 0) throw new Error(usage());
      const { txid, freezeId } = await db.prepareFreezeThenCrash(account, amount, priority);
      out({ prepared: true, txid, freezeId });
      fs.writeSync(2, 'simulated crash after PREPARE (no COMMIT written)\n');
      process.exit(2);
    }
    default:
      throw new Error(usage());
  }
}

main().catch((err) => {
  fs.writeSync(2, JSON.stringify({ ok: false, error: err.code ?? 'E_ERROR', message: err.message }) + '\n');
  process.exit(1);
});
