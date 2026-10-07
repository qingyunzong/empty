#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  LedgerError,
  accountState,
  addAccount,
  loadLedger,
  mergeLedgers,
  pay,
  removeAccount,
  saveLedger,
  transfer,
} from './src/ledger.js';

function parseArgs(argv) {
  const args = [];
  let file = 'ledger.json';
  let replica = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') file = argv[(i += 1)];
    else if (argv[i] === '--replica') replica = argv[(i += 1)];
    else args.push(argv[i]);
  }
  return { args, file, replica };
}

export function run(argv) {
  const { args, file, replica } = parseArgs(argv);
  const [command, ...rest] = args;

  try {
    if (command === 'merge') {
      const [otherFile] = rest;
      if (!otherFile) return { code: 1, json: { error: 'invalid-arguments' } };
      const ledger = loadLedger(file);
      if (replica) ledger.replica = replica;
      const other = loadLedger(otherFile);
      const { ledger: merged, added } = mergeLedgers(ledger, other);
      saveLedger(file, merged);
      return { code: 0, json: { ok: true, merged: added } };
    }

    const ledger = loadLedger(file);
    if (replica) ledger.replica = replica;

    switch (command) {
      case 'add-account': {
        const event = addAccount(ledger, rest[0]);
        saveLedger(file, ledger);
        return { code: 0, json: { ok: true, account: event.name, incarnation: event.incarnation, epoch: event.epoch } };
      }
      case 'remove-account': {
        const event = removeAccount(ledger, rest[0]);
        saveLedger(file, ledger);
        return { code: 0, json: { ok: true, account: event.name, incarnation: event.incarnation, epoch: event.epoch } };
      }
      case 'pay': {
        const event = pay(ledger, rest[0], Number(rest[1]));
        saveLedger(file, ledger);
        return { code: 0, json: { ok: true, account: event.name, balance: accountState(ledger, event.name).balance } };
      }
      case 'transfer': {
        const event = transfer(ledger, rest[0], rest[1], Number(rest[2]));
        saveLedger(file, ledger);
        return {
          code: 0,
          json: {
            ok: true,
            from: event.from,
            to: event.to,
            fromBalance: accountState(ledger, event.from).balance,
            toBalance: accountState(ledger, event.to).balance,
          },
        };
      }
      case 'account': {
        if (!rest[0]) return { code: 1, json: { error: 'invalid-arguments' } };
        return { code: 0, json: accountState(ledger, rest[0]) };
      }
      default:
        return { code: 1, json: { error: 'unknown-command' } };
    }
  } catch (err) {
    if (err instanceof LedgerError) return { code: 1, json: { error: err.code } };
    throw err;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { code, json } = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exitCode = code;
}
