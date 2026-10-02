#!/usr/bin/env node
import { Ledger, recoverLedger } from './ledger.js';
import { LedgerError } from './log.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function num(v) {
  return v === undefined ? undefined : Number(v);
}

function emit(result, exitCode) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = exitCode;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = args.dir || './ledger.db';

  if (!cmd || cmd === 'help') {
    process.stdout.write(
      [
        'usage: mledger <cmd> [--dir D] [options]',
        'commands:',
        '  receive  --batch B --material M --qty N [--parent P] --key K',
        '  reserve  --batch B --qty N --key K',
        '  issue    --batch B --qty N --key K',
        '  return   --batch B --qty N --key K',
        '  savepoint --name S',
        '  rollback --to S',
        '  snapshot',
        '  recover                 truncate corrupt tail blocks',
        '  balances',
        '  certificates',
        '',
      ].join('\n'),
    );
    return;
  }

  if (cmd === 'recover') {
    const r = recoverLedger(dir);
    emit(r, 0);
    return;
  }

  let ledger;
  try {
    ledger = Ledger.init(dir);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'E_CRC') {
      emit({ ok: false, code: 'E_CRC', message: err.message, offset: err.offset }, 2);
      return;
    }
    throw err;
  }

  const qty = num(args.qty);
  let result;
  switch (cmd) {
    case 'receive':
      result = ledger.receive({ key: args.key, batch: args.batch, material: args.material, qty, parent: args.parent ?? null });
      break;
    case 'reserve':
      result = ledger.reserve({ key: args.key, batch: args.batch, qty });
      break;
    case 'issue':
      result = ledger.issue({ key: args.key, batch: args.batch, qty });
      break;
    case 'return':
      result = ledger.returnMaterial({ key: args.key, batch: args.batch, qty });
      break;
    case 'savepoint':
      result = ledger.savepoint(args.name);
      break;
    case 'rollback':
      result = ledger.rollback(args.to);
      break;
    case 'snapshot':
      result = ledger.snapshot();
      break;
    case 'balances':
      result = { ok: true, code: 'OK', balances: ledger.balances() };
      break;
    case 'certificates':
      result = { ok: true, code: 'OK', certificates: ledger.certificates };
      break;
    default:
      result = { ok: false, code: 'E_ARG', message: `unknown command ${cmd}` };
  }
  emit(result, result.ok ? 0 : 1);
}

main();
