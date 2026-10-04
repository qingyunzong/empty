#!/usr/bin/env node
// credit-ledger CLI
//   node bin/cli.js [--commands <file>|-] [--log <file>] [--trace]
// Reads JSONL commands (stdin when --commands is '-' or omitted), applies them
// to the ledger (restoring prior state from --log first), appends applied
// commands to --log, and prints the account snapshot as JSON to stdout.
// --trace also prints one JSON line per applied command explaining the change.
// Any command error: message to stderr, exit code 4.

import fs from 'node:fs';
import { Ledger, LedgerError } from '../src/ledger.js';
import { EventLog } from '../src/store.js';

function parseArgs(argv) {
  const args = { commands: '-', log: null, trace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--commands') args.commands = argv[++i];
    else if (argv[i] === '--log') args.log = argv[++i];
    else if (argv[i] === '--trace') args.trace = true;
    else if (argv[i] === '--help') {
      console.log('usage: credit-ledger [--commands <file>|-] [--log <file>] [--trace]');
      process.exit(0);
    } else {
      fail('VALIDATION', `unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function fail(code, message) {
  process.stderr.write(`ERROR ${code} ${message}\n`);
  process.exit(4);
}

function readCommands(path) {
  const text = path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8');
  const cmds = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      cmds.push(JSON.parse(trimmed));
    } catch {
      fail('BAD_JSON', `line ${i + 1}: invalid JSON`);
    }
  });
  return cmds;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledger = new Ledger();
  let log = null;

  if (args.log) {
    log = new EventLog(args.log);
    const info = log.open();
    if (info.repaired) {
      process.stderr.write(`recovered log ${args.log}: truncated ${info.truncatedBytes} torn bytes\n`);
    }
    for (const entry of info.events) ledger.apply(entry.cmd);
  }

  const cmds = readCommands(args.commands);
  for (const cmd of cmds) {
    let rec;
    try {
      rec = ledger.apply(cmd);
    } catch (err) {
      if (err instanceof LedgerError) fail(err.code, err.message);
      throw err;
    }
    if (log) log.append({ cmd });
    if (args.trace) process.stdout.write(JSON.stringify(rec) + '\n');
  }
  if (log) log.close();

  process.stdout.write(JSON.stringify(ledger.snapshot(), null, 2) + '\n');
}

main();
