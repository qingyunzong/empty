'use strict';

const fs = require('node:fs');
const { Ledger } = require('./ledger');
const { LedgerError } = require('./errors');

const USAGE = 'usage: node cli.js <event.json | JSON string> <workdir>';

function readEvent(eventArg) {
  const raw = fs.existsSync(eventArg) ? fs.readFileSync(eventArg, 'utf8') : eventArg;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new LedgerError('INVALID_JSON', `failed to parse event JSON: ${error.message}`);
  }
}

function run(args, { stdout = console.log, stderr = console.error } = {}) {
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      stdout(USAGE);
      return 0;
    }
    if (args.length !== 2) {
      throw new LedgerError('INVALID_ARGS', USAGE);
    }
    const event = readEvent(args[0]);
    const ledger = new Ledger(args[1]);
    const certificate = ledger.process(event);
    stdout(JSON.stringify(certificate, null, 2));
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ error: error.code || 'INTERNAL', message: error.message }));
    return 1;
  }
}

module.exports = { run, USAGE };
