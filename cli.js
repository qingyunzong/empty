#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Ledger, LedgerError } = require('./ledger');

class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.exitCode = code;
  }
}

function main(argv, write = (s) => process.stdout.write(s), env = process.env) {
  const ledgerFile = () => env.LEDGER_FILE || 'ledger.json';

  const load = () => {
    const file = ledgerFile();
    if (fs.existsSync(file)) {
      return Ledger.fromJSON(fs.readFileSync(file, 'utf8'));
    }
    return new Ledger(env.REPLICA_ID || 'replica-1');
  };

  const save = (ledger) => {
    fs.writeFileSync(ledgerFile(), JSON.stringify(ledger.toJSON(), null, 2) + '\n');
  };

  const out = (value) => write(JSON.stringify(value) + '\n');
  const fail = (code) => {
    out({ error: code });
    throw new ExitError(1);
  };

  const readJsonArg = (raw) => {
    if (raw == null) fail('missing-argument');
    try {
      return JSON.parse(raw);
    } catch {
      fail('invalid-json');
    }
  };

  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'put': {
        const ledger = load();
        const event = ledger.put(readJsonArg(rest[0]));
        save(ledger);
        out(event);
        return 0;
      }
      case 'correct': {
        const ledger = load();
        const event = ledger.correct(readJsonArg(rest[0]));
        save(ledger);
        out(event);
        return 0;
      }
      case 'merge': {
        const file = rest[0];
        if (!file) fail('missing-argument');
        let other;
        try {
          other = Ledger.fromJSON(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          fail(err instanceof SyntaxError ? 'invalid-json' : 'io-error');
        }
        const ledger = load();
        const result = ledger.merge(other);
        save(ledger);
        out(result);
        return 0;
      }
      case 'audit': {
        out(load().audit());
        return 0;
      }
      case 'get': {
        const voucherId = rest[0];
        if (!voucherId) fail('missing-argument');
        out(load().get(voucherId));
        return 0;
      }
      default:
        fail(command ? 'unknown-command' : 'missing-command');
    }
  } catch (err) {
    if (err instanceof ExitError) return err.exitCode;
    if (err instanceof LedgerError) {
      out({ error: err.code });
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main };
