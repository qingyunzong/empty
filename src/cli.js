'use strict';

const fs = require('node:fs');
const { Ledger } = require('./ledger');
const { LedgerError, E } = require('./errors');

function parseArgs(argv) {
  if (argv[0] !== 'apply') {
    throw E.usage('usage: card apply <events.jsonl> [--stats <merchant> <day>]');
  }
  const file = argv[1];
  if (!file) throw E.usage('usage: card apply <events.jsonl> [--stats <merchant> <day>]');
  const rest = argv.slice(2);
  let stats = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--stats') {
      const merchant = rest[i + 1];
      const day = rest[i + 2];
      if (!merchant || !day) throw E.usage('--stats requires <merchant> <day>');
      stats = { merchant, day };
      i += 2;
    } else {
      throw E.usage(`unknown argument: ${rest[i]}`);
    }
  }
  return { file, stats };
}

// Runs the CLI. `io` provides writeStdout/writeStderr; returns the exit code.
function run(argv, io) {
  const fail = (err) => {
    const code = err instanceof LedgerError ? err.code : 'E_INTERNAL';
    io.writeStderr(JSON.stringify({ code, message: err.message }) + '\n');
    return 1;
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return fail(err);
  }

  let text;
  try {
    text = fs.readFileSync(args.file, 'utf8');
  } catch {
    return fail(E.validation(`cannot read file: ${args.file}`));
  }

  const ledger = new Ledger();
  const lines = text.split('\n');
  let applied = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      return fail(E.parse(i + 1, err.message));
    }
    try {
      ledger.apply(event);
    } catch (err) {
      return fail(err);
    }
    applied += 1;
  }

  const out = { applied };
  if (args.stats) out.stats = ledger.merchantStats(args.stats.merchant, args.stats.day);
  io.writeStdout(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

const processIO = {
  writeStdout: (s) => process.stdout.write(s),
  writeStderr: (s) => process.stderr.write(s),
};

module.exports = { run, processIO };
