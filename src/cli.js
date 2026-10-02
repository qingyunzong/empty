#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';
import { SplitError } from './split.js';

function parseArgs(argv) {
  const args = { event: null, workdir: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--event' || arg === '-e') args.event = argv[++i];
    else if (arg === '--workdir' || arg === '-w') args.workdir = argv[++i];
    else if (arg.startsWith('--event=')) args.event = arg.slice('--event='.length);
    else if (arg.startsWith('--workdir=')) args.workdir = arg.slice('--workdir='.length);
    else positional.push(arg);
  }
  if (args.event === null && positional.length > 0) args.event = positional[0];
  if (args.workdir === null && positional.length > 1) args.workdir = positional[1];
  return args;
}

function readEventJson(raw) {
  if (raw === '-') return fs.readFileSync(0, 'utf8');
  if (raw.startsWith('@')) return fs.readFileSync(raw.slice(1), 'utf8');
  if (!raw.trimStart().startsWith('{') && fs.existsSync(raw)) return fs.readFileSync(raw, 'utf8');
  return raw;
}

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ error: code, message })}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.event === null || args.event === undefined) {
    fail('INVALID_EVENT', 'missing event JSON (usage: cli.js --event <json|@file> --workdir <dir>)');
  }
  if (!args.workdir) {
    fail('INVALID_WORKDIR', 'missing workdir (usage: cli.js --event <json|@file> --workdir <dir>)');
  }
  let event;
  try {
    event = JSON.parse(readEventJson(args.event));
  } catch (err) {
    fail('INVALID_EVENT', `event is not valid JSON: ${err.message}`);
  }
  try {
    const ledger = new Ledger(args.workdir);
    const certificate = ledger.handleEvent(event);
    process.stdout.write(`${JSON.stringify(certificate, null, 2)}\n`);
  } catch (err) {
    if (err instanceof LedgerError || err instanceof SplitError) fail(err.code, err.message);
    fail('INTERNAL', err.message);
  }
}

main();
