#!/usr/bin/env node
import { Ledger, LedgerError } from './ledger.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function fail(code, message, exitCode = 1) {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
  process.exit(exitCode);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const dir = args.dir ?? process.env.LEDGER_DIR ?? './ledger-data';

  if (!command) fail('E_USAGE', 'usage: ledger <pay|cancel|audit|recover|crash> [options]', 2);

  const ledger = new Ledger(dir).open();
  try {
    switch (command) {
      case 'pay': {
        const amount = Number(args.amount);
        const txn = ledger.pay({ id: args.id, merchant: args.merchant, amount });
        process.stdout.write(JSON.stringify({ ok: true, transaction: txn }) + '\n');
        break;
      }
      case 'cancel': {
        const txn = ledger.cancel({ id: args.id });
        process.stdout.write(JSON.stringify({ ok: true, transaction: txn }) + '\n');
        break;
      }
      case 'audit': {
        if (!args.merchant) fail('E_USAGE', 'audit requires --merchant M', 2);
        process.stdout.write(JSON.stringify({ ok: true, ...ledger.audit(args.merchant) }) + '\n');
        break;
      }
      case 'recover': {
        process.stdout.write(JSON.stringify({ ok: true, ...ledger.recover() }) + '\n');
        break;
      }
      case 'crash': {
        const point = args.point;
        if (point !== 'P1' && point !== 'P2') {
          fail('E_USAGE', 'crash requires --point P1 or --point P2', 2);
        }
        const amount = Number(args.amount);
        ledger.pay({ id: args.id, merchant: args.merchant, amount, crashPoint: point });
        break;
      }
      default:
        fail('E_USAGE', `unknown command: ${command}`, 2);
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      fail(err.code, err.message);
    }
    throw err;
  } finally {
    ledger.close();
  }
}

main();
