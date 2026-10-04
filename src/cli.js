#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';

const USAGE = `Usage: node src/cli.js [--state <file>] <command> [options]

Commands:
  batch create --id <id> --day <yyyy-mm-dd> [--parent <id>]
  batch settle --id <id>
  tx add --id <id> --batch <id> --account <name> --amount <n> --day <yyyy-mm-dd> [--corrects <txId>]
  day close --day <yyyy-mm-dd>
  savepoint create --id <id> --batch <id>
  rollback plan --savepoint <id> [--reverse]
  rollback exec --savepoint <id> [--reverse]
  status
  hash
`;

function parseArgv(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function requireOpt(opts, name) {
  const value = opts[name];
  if (value === undefined || value === true) {
    throw new LedgerError('E_INVAL', `missing required option --${name}`);
  }
  return value;
}

function loadLedger(statePath) {
  if (!existsSync(statePath)) return new Ledger();
  return Ledger.fromJSON(JSON.parse(readFileSync(statePath, 'utf8')));
}

function saveLedger(statePath, ledger) {
  writeFileSync(statePath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`);
}

function summarizeTx(tx) {
  return {
    id: tx.id,
    batchId: tx.batchId,
    account: tx.account,
    amount: tx.amount,
    day: tx.day,
    seq: tx.seq,
    status: tx.status,
    corrects: tx.corrects,
    reverses: tx.reverses,
    correctedBy: tx.correctedBy,
    reversedBy: tx.reversedBy,
  };
}

function main() {
  const { positional, opts } = parseArgv(process.argv.slice(2));
  const statePath = typeof opts.state === 'string' ? opts.state : 'ledger.json';
  const [command, sub] = positional;
  const ledger = loadLedger(statePath);

  let result;
  let dirty = false;

  if (command === 'batch' && sub === 'create') {
    result = ledger.createBatch({
      id: requireOpt(opts, 'id'),
      parentId: opts.parent ?? null,
      day: requireOpt(opts, 'day'),
    });
    dirty = true;
  } else if (command === 'batch' && sub === 'settle') {
    result = ledger.settleBatch(requireOpt(opts, 'id'));
    dirty = true;
  } else if (command === 'tx' && sub === 'add') {
    result = ledger.addTx({
      id: requireOpt(opts, 'id'),
      batchId: requireOpt(opts, 'batch'),
      account: requireOpt(opts, 'account'),
      amount: Number(requireOpt(opts, 'amount')),
      day: requireOpt(opts, 'day'),
      corrects: opts.corrects ?? null,
    });
    dirty = true;
  } else if (command === 'day' && sub === 'close') {
    result = { closed: ledger.closeDay(requireOpt(opts, 'day')) };
    dirty = true;
  } else if (command === 'savepoint' && sub === 'create') {
    result = ledger.createSavepoint({ id: requireOpt(opts, 'id'), batchId: requireOpt(opts, 'batch') });
    dirty = true;
  } else if (command === 'rollback' && sub === 'plan') {
    result = ledger.planRollback(requireOpt(opts, 'savepoint'), { reverse: Boolean(opts.reverse) });
  } else if (command === 'rollback' && sub === 'exec') {
    const plan = ledger.planRollback(requireOpt(opts, 'savepoint'), { reverse: Boolean(opts.reverse) });
    const execution = ledger.executeRollback(plan);
    result = { plan, execution };
    dirty = true;
  } else if (command === 'status') {
    result = {
      hash: ledger.hash(),
      balances: ledger.balances(),
      batches: [...ledger.batches.values()],
      txs: ledger.log.map(summarizeTx),
      savepoints: [...ledger.savepoints.values()],
      closedDays: [...ledger.closedDays],
    };
  } else if (command === 'hash') {
    result = { hash: ledger.hash() };
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (dirty) saveLedger(statePath, ledger);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof LedgerError) {
    const { code, message, ...details } = error;
    process.stderr.write(`${JSON.stringify({ error: code, message, ...details }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
