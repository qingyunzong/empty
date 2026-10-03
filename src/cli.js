#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Ledger } = require('./ledger');

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      opts[argv[i].slice(2)] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { opts, positional };
}

function required(opts, name) {
  if (opts[name] === undefined) throw new Error(`missing required option --${name}`);
  return opts[name];
}

// Runs one CLI command against the data directory. Every invocation opens a
// fresh Ledger, i.e. performs full recovery from disk, exactly like a
// separate OS process would. Returns the process-style exit code; output
// lines are delivered to `log`.
function run(argv, log = (line) => console.log(line)) {
  const { opts, positional } = parseArgs(argv);
  const dir = opts.data || path.join(process.cwd(), 'ledger-data');
  const [command] = positional;
  const ledger = new Ledger(dir);

  switch (command) {
    case 'pay':
      log(String(ledger.pay(required(opts, 'tx'), required(opts, 'account'), Number(required(opts, 'amount')))));
      return 0;
    case 'cancel':
      log(String(ledger.cancel(required(opts, 'tx'))));
      return 0;
    case 'begin-snapshot':
      log(ledger.beginSnapshot());
      return 0;
    case 'end-snapshot':
      ledger.endSnapshot(required(opts, 'id'));
      return 0;
    case 'get': {
      const at = opts.at === undefined ? ledger.version : ledger.resolveAt(opts.at);
      log(String(ledger.getAt(required(opts, 'account'), at)));
      return 0;
    }
    case 'checkpoint':
      log(`checkpoint at version ${ledger.checkpoint()}`);
      return 0;
    case 'crash':
      // Simulate abrupt death mid-checkpoint: the tmp file is left exactly as
      // the crash point dictates; no rename, no cleanup, nothing else flushed.
      ledger.crashCheckpoint(required(opts, 'point'));
      return 1;
    case 'dump':
      log(JSON.stringify(ledger.dump()));
      return 0;
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
}

if (require.main === module) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(70);
  }
}

module.exports = { run };
