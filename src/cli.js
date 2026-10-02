#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(code) {
  process.stderr.write(JSON.stringify({ error: code }) + '\n');
  process.exit(1);
}

function loadDb(path, replicaForCreate) {
  if (!path) throw new LedgerError('usage', '--db is required');
  if (existsSync(path)) return Ledger.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
  if (!replicaForCreate) {
    throw new LedgerError('usage', `db ${path} does not exist; pass --replica to create it`);
  }
  return new Ledger(replicaForCreate);
}

function saveDb(path, ledger) {
  writeFileSync(path, JSON.stringify(ledger.toJSON(), null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  switch (command) {
    case 'append': {
      const ledger = loadDb(args.db, args.replica);
      if (args.replica && ledger.replica !== args.replica) {
        throw new LedgerError('replica-mismatch', `db belongs to replica ${ledger.replica}`);
      }
      const event = ledger.append({
        type: args.type,
        paymentId: args.payment,
        amount: Number(args.amount),
      });
      saveDb(args.db, ledger);
      out(event);
      break;
    }
    case 'merge': {
      const ledger = loadDb(args.db, args.replica);
      if (!args.file) throw new LedgerError('usage', 'merge requires --file');
      const raw = JSON.parse(readFileSync(args.file, 'utf8'));
      const events = Array.isArray(raw) ? raw : Array.isArray(raw.events) ? raw.events : [raw];
      const applied = ledger.merge(events);
      saveDb(args.db, ledger);
      out({
        merged: applied.length,
        hashes: applied,
        frontier: [...ledger.frontier].sort(),
        clock: ledger.clock,
      });
      break;
    }
    case 'dump': {
      const ledger = loadDb(args.db);
      const { balances, conflicts } = ledger.computeState();
      out({ ...ledger.toJSON(), balances, conflicts });
      break;
    }
    case 'cert': {
      const ledger = loadDb(args.db);
      out(ledger.certificate());
      break;
    }
    default:
      throw new LedgerError('usage', 'commands: append | merge | dump | cert');
  }
}

try {
  main();
} catch (e) {
  if (e instanceof LedgerError) fail(e.code);
  if (e && e.code === 'ENOENT') fail('not-found');
  if (e instanceof SyntaxError) fail('invalid-json');
  fail('internal');
}
