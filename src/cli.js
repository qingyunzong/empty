#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  SettlementError,
  rebuildState,
  executeCommand,
  appendEventToLog,
  snapshot,
} = require('./settlement');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (i + 1 >= argv.length) {
        throw new SettlementError('INVALID_INPUT', `missing value for --${name}`);
      }
      args[name] = argv[i + 1];
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !args.log) {
    throw new SettlementError(
      'INVALID_INPUT',
      'usage: node src/cli.js <submit|rebuild> --log <dir> [--input <file.json>]',
    );
  }

  if (command === 'submit') {
    if (!args.input) {
      throw new SettlementError('INVALID_INPUT', 'submit requires --input <file.json>');
    }
    let input;
    try {
      input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
    } catch (err) {
      throw new SettlementError('INVALID_INPUT', `cannot read or parse input file: ${err.message}`);
    }
    const state = rebuildState(args.log);
    const result = executeCommand(state, input, (event) => appendEventToLog(args.log, event));
    process.stdout.write(JSON.stringify(result.certificate, null, 2) + '\n');
    return;
  }

  if (command === 'rebuild') {
    const state = rebuildState(args.log);
    process.stdout.write(JSON.stringify(snapshot(state), null, 2) + '\n');
    return;
  }

  throw new SettlementError('UNKNOWN_COMMAND', `unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  const code = err instanceof SettlementError ? err.code : 'INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exitCode = 1;
}
