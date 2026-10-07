#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Ledger, LedgerError } = require('./src/ledger');

class Exit extends Error {
  constructor(code) {
    super('exit');
    this.code = code;
  }
}

function runCli(argv, options = {}) {
  const file = options.ledgerFile || process.env.LEDGER_FILE || 'ledger.json';
  const write = options.write || ((s) => process.stdout.write(s));
  const fail = (code) => {
    write(`${JSON.stringify({ error: code })}\n`);
    throw new Exit(1);
  };
  const print = (obj) => write(`${JSON.stringify(obj)}\n`);

  const load = () => {
    if (!fs.existsSync(file)) return new Ledger();
    try {
      return Ledger.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err instanceof LedgerError) fail(err.code);
      fail('invalid-input');
    }
    return null;
  };
  const save = (ledger) => {
    fs.writeFileSync(file, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`);
  };
  const head = (ledger) => {
    const heads = ledger.heads();
    return heads.length ? heads[0] : null;
  };

  try {
    const [command, ...args] = argv;
    const ledger = load();
    switch (command) {
      case 'trade': {
        const [tradeId] = args;
        if (!tradeId) fail('usage');
        const event = { id: randomUUID(), type: 'trade', tradeId, prev: head(ledger) };
        const { hash } = ledger.addEvent(event);
        save(ledger);
        print({ ok: true, hash, ...ledger.getTrade(tradeId) });
        break;
      }
      case 'cancel': {
        const [tradeId] = args;
        if (!tradeId) fail('usage');
        const trade = ledger.tradeEvent(tradeId);
        if (!trade) fail('unknown-trade');
        const event = { id: randomUUID(), type: 'cancel', tradeId, tradeHash: trade.hash, prev: head(ledger) };
        const { hash } = ledger.addEvent(event);
        save(ledger);
        print({ ok: true, hash, ...ledger.getTrade(tradeId) });
        break;
      }
      case 'restore': {
        const [tradeId] = args;
        if (!tradeId) fail('usage');
        const status = ledger.getTrade(tradeId);
        if (!status.tombstone) fail('restore-without-cancel');
        const event = { id: randomUUID(), type: 'restore', tradeId, cancelHash: status.tombstone, prev: head(ledger) };
        const { hash } = ledger.addEvent(event);
        save(ledger);
        print({ ok: true, hash, ...ledger.getTrade(tradeId) });
        break;
      }
      case 'merge': {
        const [mergeFile] = args;
        if (!mergeFile) fail('usage');
        let data;
        try {
          data = JSON.parse(fs.readFileSync(mergeFile, 'utf8'));
        } catch {
          fail('invalid-input');
        }
        const events = Array.isArray(data) ? data : data.events;
        const result = ledger.merge(events);
        save(ledger);
        print({ ok: true, ...result });
        break;
      }
      case 'get': {
        const [tradeId] = args;
        if (!tradeId) fail('usage');
        print(ledger.getTrade(tradeId));
        break;
      }
      default:
        fail('usage');
    }
    return 0;
  } catch (err) {
    if (err instanceof Exit) return err.code;
    if (err instanceof LedgerError) {
      write(`${JSON.stringify({ error: err.code })}\n`);
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}

module.exports = { runCli };
