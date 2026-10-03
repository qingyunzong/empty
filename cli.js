#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BudgetService } from './src/budget.js';
import { NO_ACCOUNT, CONFLICT, BUDGET_EXCEEDED, ACCOUNT_EXISTS } from './src/errors.js';

const EXIT_CODES = {
  [NO_ACCOUNT]: 2,
  [CONFLICT]: 3,
  [BUDGET_EXCEEDED]: 4,
  [ACCOUNT_EXISTS]: 5,
};

const USAGE = `Usage: node cli.js [--data-dir DIR] <command> [args]

Commands:
  create-account <name> <balance>   Create a budget account
  debit <name> <amount> [note]      Debit budget and write a usage record (one transaction)
  balance <name>                    Print current balance
  usage [name]                      List usage records (optionally for one account)
  history                           List committed transactions

Error codes (stderr "ERROR <CODE> ...", non-zero exit):
  NO_ACCOUNT(2) CONFLICT(3, retryable) BUDGET_EXCEEDED(4) ACCOUNT_EXISTS(5)`;

function parseArgs(argv) {
  let dataDir = process.env.BUDGET_DATA_DIR ?? './budget-data';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') dataDir = argv[++i];
    else rest.push(argv[i]);
  }
  return { dataDir, rest };
}

// Returns the process exit code. Injectable out/err keep it testable
// in-process; each invocation reopens the store from --data-dir, exactly
// like a fresh process would.
export async function run(argv, { out = console.log, err = console.error } = {}) {
  const { dataDir, rest } = parseArgs(argv);
  const [cmd, ...args] = rest;
  if (!cmd) {
    err(USAGE);
    return 1;
  }
  try {
    const svc = new BudgetService(dataDir);
    switch (cmd) {
      case 'create-account': {
        const [name, balance] = args;
        const txid = await svc.createAccount(name, Number(balance));
        out(JSON.stringify({ ok: true, txid, account: name, balance: Number(balance) }));
        break;
      }
      case 'debit': {
        const [name, amount, note = ''] = args;
        const { txid, balance } = await svc.debit(name, Number(amount), note, { retries: 5 });
        out(JSON.stringify({ ok: true, txid, account: name, debited: Number(amount), balance }));
        break;
      }
      case 'balance': {
        out(JSON.stringify({ account: args[0], balance: svc.balance(args[0]) }));
        break;
      }
      case 'usage': {
        out(JSON.stringify(svc.usage(args[0] ?? null), null, 2));
        break;
      }
      case 'history': {
        out(JSON.stringify(svc.history(), null, 2));
        break;
      }
      default:
        err(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
    return 0;
  } catch (e) {
    const code = e.code ?? 'INTERNAL';
    err(`ERROR ${code} ${e.message}`);
    return EXIT_CODES[code] ?? 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  process.exit(await run(process.argv.slice(2)));
}
