#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const ledger = require('./ledger');

const USAGE = [
  'usage:',
  '  settle add-account <name> [--state file]',
  '  settle remove-account <name> [--state file]',
  '  settle transfer <from> <to> <amount> [--state file]',
  '  settle pay <account> <amount> [--state file]',
  '  settle merge <file> [--state file]',
  '  settle account <name> [--state file]',
].join('\n');

function parseArgs(argv) {
  const positional = [];
  let state = process.env.LEDGER_FILE || 'ledger.json';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') {
      state = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--state=')) {
      state = arg.slice('--state='.length);
    } else {
      positional.push(arg);
    }
  }
  return { positional, state };
}

function loadLedger(file) {
  if (!fs.existsSync(file)) return ledger.createLedger();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ledger.LedgerError('invalid-ledger');
  }
  if (!data || !Array.isArray(data.events)) throw new ledger.LedgerError('invalid-ledger');
  for (const event of data.events) {
    try {
      ledger.validateEventShape(event);
    } catch {
      throw new ledger.LedgerError('invalid-ledger');
    }
  }
  return data;
}

function saveLedger(file, state) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function parseAmount(raw) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new ledger.LedgerError('invalid-amount');
  return amount;
}

function run(argv) {
  const { positional, state } = parseArgs(argv);
  const [command, ...args] = positional;
  const stateFile = state;

  switch (command) {
    case 'add-account': {
      if (args.length !== 1) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const event = ledger.appendEvent(db, { type: 'add-account', account: args[0] });
      saveLedger(stateFile, db);
      return { event };
    }
    case 'remove-account': {
      if (args.length !== 1) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const event = ledger.appendEvent(db, { type: 'remove-account', account: args[0] });
      saveLedger(stateFile, db);
      return { event };
    }
    case 'transfer': {
      if (args.length !== 3) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const event = ledger.appendEvent(db, {
        type: 'transfer',
        from: args[0],
        to: args[1],
        amount: parseAmount(args[2]),
      });
      saveLedger(stateFile, db);
      return { event };
    }
    case 'pay': {
      if (args.length !== 2) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const event = ledger.appendEvent(db, {
        type: 'pay',
        account: args[0],
        amount: parseAmount(args[1]),
      });
      saveLedger(stateFile, db);
      return { event };
    }
    case 'merge': {
      if (args.length !== 1) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const other = loadLedger(args[0]);
      const merged = ledger.mergeLedgers(db, other);
      saveLedger(stateFile, db);
      return { merged, total: db.events.length, conflicts: ledger.allConflicts(db) };
    }
    case 'account': {
      if (args.length !== 1) throw new ledger.LedgerError('usage');
      const db = loadLedger(stateFile);
      const name = args[0];
      const stateOf = ledger.accountState(db, name);
      return {
        name,
        status: stateOf.status,
        incarnation: stateOf.incarnation,
        epoch: stateOf.epoch,
        balance: stateOf.balance,
        tombstone: stateOf.tombstone
          ? { id: stateOf.tombstone.id, epoch: stateOf.tombstone.epoch }
          : null,
        conflicts: ledger.accountConflicts(db, name),
        history: ledger.accountHistory(db, name),
      };
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      throw new ledger.LedgerError('usage');
  }
}

function main() {
  try {
    const result = run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof ledger.LedgerError ? error.code : 'internal-error';
    process.stdout.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { run };
