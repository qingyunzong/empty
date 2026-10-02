#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerError } from './src/ledger.js';

// Runs one CLI command. Returns the process exit code (0 ok, 1 error) and
// emits exactly one JSON line through `stdout`. Kept side-effect free with
// respect to process state so tests can drive it in-process.
export function runCli(argv, options = {}) {
  const ledgerPath = options.ledgerPath ?? process.env.LEDGER_FILE ?? 'ledger.json';
  const emit = options.stdout ?? ((line) => process.stdout.write(line + '\n'));

  const fail = (code) => {
    emit(JSON.stringify({ error: code }));
    return 1;
  };

  const loadLedger = () => {
    if (!existsSync(ledgerPath)) return { ledger: new Ledger() };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    } catch {
      return { error: 'invalid-ledger-file' };
    }
    const events = Array.isArray(parsed) ? parsed : parsed?.events;
    if (!Array.isArray(events)) return { error: 'invalid-ledger-file' };
    try {
      return { ledger: new Ledger(events) };
    } catch (err) {
      if (err instanceof LedgerError) return { error: err.code };
      throw err;
    }
  };

  const saveLedger = (ledger) => {
    writeFileSync(ledgerPath, JSON.stringify({ events: ledger.events() }, null, 2) + '\n');
  };

  try {
    const [command, ...args] = argv;
    if (!command) return fail('missing-command');

    const loaded = loadLedger();
    if (loaded.error) return fail(loaded.error);
    const ledger = loaded.ledger;

    switch (command) {
      case 'trade':
      case 'cancel':
      case 'restore': {
        const [tradeId] = args;
        if (!tradeId) return fail('missing-argument');
        const create = { trade: 'createTrade', cancel: 'createCancel', restore: 'createRestore' }[command];
        const event = ledger[create](tradeId);
        saveLedger(ledger);
        emit(JSON.stringify(event));
        return 0;
      }
      case 'merge': {
        const [file] = args;
        if (!file) return fail('missing-argument');
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          return fail('invalid-json');
        }
        const events = Array.isArray(parsed) ? parsed : parsed?.events;
        if (!Array.isArray(events)) return fail('invalid-events');
        const result = ledger.merge(events);
        saveLedger(ledger);
        emit(JSON.stringify(result));
        return 0;
      }
      case 'get': {
        const [tradeId] = args;
        if (!tradeId) return fail('missing-argument');
        emit(JSON.stringify(ledger.getState(tradeId)));
        return 0;
      }
      default:
        return fail('unknown-command');
    }
  } catch (err) {
    if (err instanceof LedgerError) return fail(err.code);
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
