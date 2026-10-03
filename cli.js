#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Ledger, LedgerError } = require('./lib/ledger');

function fail(code) {
  process.stderr.write(JSON.stringify({ error: code }) + '\n');
  process.exit(1);
}

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function loadLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Ledger();
    fail('io-error');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('invalid-json');
  }
  const events = Array.isArray(data) ? data : data.events;
  if (!Array.isArray(events)) fail('invalid-ledger');
  try {
    return new Ledger(events);
  } catch (err) {
    if (err instanceof LedgerError) fail(err.code);
    throw err;
  }
}

function saveLedger(file, ledger) {
  fs.writeFileSync(file, JSON.stringify(ledger.toJSON()) + '\n');
}

function readEventsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail('io-error');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('invalid-json');
  }
  const events = Array.isArray(data) ? data : data.events;
  if (!Array.isArray(events)) fail('invalid-json');
  return events;
}

function cmdAppend(ledgerFile, specJson) {
  let spec;
  try {
    spec = JSON.parse(specJson);
  } catch {
    fail('invalid-json');
  }
  const ledger = loadLedger(ledgerFile);
  let event;
  try {
    event = Ledger.createEvent(spec, ledger);
  } catch (err) {
    if (err instanceof LedgerError) fail(err.code);
    throw err;
  }
  try {
    ledger.addEvent(event);
  } catch (err) {
    if (err instanceof LedgerError) fail(err.code);
    throw err;
  }
  saveLedger(ledgerFile, ledger);
  print(event);
}

function cmdMerge(ledgerFile, inputFile) {
  const ledger = loadLedger(ledgerFile);
  const incoming = readEventsFile(inputFile);
  const added = [];
  const duplicates = [];
  const pending = [...incoming];
  try {
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const event = pending[i];
        try {
          const result = ledger.addEvent(event);
          (result === 'added' ? added : duplicates).push(event.hash);
          pending.splice(i, 1);
          i--;
          progress = true;
        } catch (err) {
          if (err instanceof LedgerError && err.code === 'unknown-predecessor') continue;
          throw err;
        }
      }
    }
  } catch (err) {
    if (err instanceof LedgerError) fail(err.code);
    throw err;
  }
  if (pending.length > 0) fail('unknown-predecessor');
  saveLedger(ledgerFile, ledger);
  print({ added, duplicates });
}

function cmdDump(ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  print(ledger.toJSON().events);
}

function cmdCert(ledgerFile) {
  const ledger = loadLedger(ledgerFile);
  try {
    print(ledger.certificate());
  } catch (err) {
    if (err instanceof LedgerError) fail(err.code);
    throw err;
  }
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'append':
      if (args.length !== 2) fail('usage');
      cmdAppend(args[0], args[1]);
      break;
    case 'merge':
      if (args.length !== 2) fail('usage');
      cmdMerge(args[0], args[1]);
      break;
    case 'dump':
      if (args.length !== 1) fail('usage');
      cmdDump(args[0]);
      break;
    case 'cert':
      if (args.length !== 1) fail('usage');
      cmdCert(args[0]);
      break;
    default:
      fail('usage');
  }
}

main(process.argv.slice(2));
