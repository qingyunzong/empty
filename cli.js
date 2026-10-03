#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerError } from './src/ledger.js';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

export function runCli(argv, emit = (line) => process.stdout.write(line + '\n')) {
  const fail = (code) => {
    emit(JSON.stringify({ error: code }));
    return 1;
  };

  const { positional, opts } = parseArgs(argv);
  const [command, ...args] = positional;
  const statePath = opts.state ?? process.env.AUDIT_STATE ?? 'ledger.json';

  let ledger;
  if (existsSync(statePath)) {
    ledger = Ledger.fromJSON(JSON.parse(readFileSync(statePath, 'utf8')));
  } else {
    ledger = new Ledger('replica-1');
  }
  if (opts.replica ?? process.env.AUDIT_REPLICA) {
    ledger.replica = opts.replica ?? process.env.AUDIT_REPLICA;
  }

  const save = () => writeFileSync(statePath, JSON.stringify(ledger.toJSON(), null, 2) + '\n');

  try {
    switch (command) {
      case 'put': {
        const [voucherId, amount, status] = args;
        if (!voucherId || amount === undefined || !status) return fail('usage');
        emit(JSON.stringify(ledger.put(voucherId, Number(amount), status)));
        save();
        return 0;
      }
      case 'correct': {
        const [voucherId, amount, status] = args;
        if (!voucherId || amount === undefined || !status) return fail('usage');
        emit(JSON.stringify(ledger.correct(voucherId, Number(amount), status, opts.predecessor)));
        save();
        return 0;
      }
      case 'merge': {
        const [file] = args;
        if (!file) return fail('usage');
        const other = Ledger.fromJSON(JSON.parse(readFileSync(file, 'utf8')));
        ledger.merge(other);
        save();
        emit(JSON.stringify({ merged: true, events: ledger.events.size }));
        return 0;
      }
      case 'audit': {
        emit(JSON.stringify(ledger.certificate()));
        return 0;
      }
      case 'get': {
        const [voucherId] = args;
        if (!voucherId) return fail('usage');
        emit(JSON.stringify(ledger.get(voucherId)));
        return 0;
      }
      default:
        return fail('usage');
    }
  } catch (err) {
    if (err instanceof LedgerError) return fail(err.code);
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
