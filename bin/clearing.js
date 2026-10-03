#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger, LedgerError } from '../src/ledger.js';
import { Store } from '../src/store.js';

function parseArgs(argv) {
  const args = { state: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      i += 1;
      if (i >= argv.length) fail('BAD_ARGS', '--state requires a directory');
      args.state = argv[i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: clearing [--state DIR] < events.jsonl\n');
      process.exit(0);
    } else {
      fail('BAD_ARGS', `unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: true, code, message }) + '\n');
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let store = null;
  const ledger = new Ledger({
    onJournal: (entry) => store?.appendJournal(entry),
    onBatch: (batch) => store?.writeBatch(batch),
  });

  if (args.state) {
    store = new Store(args.state);
    store.init(); // removes stale *.tmp from interrupted batch writes
    const { events, truncated } = store.loadJournal();
    if (truncated) {
      process.stderr.write(
        JSON.stringify({ warning: 'truncated torn journal tail from interrupted write' }) + '\n'
      );
    }
    for (const event of events) ledger.applyEvent(event, { journal: false });
    // Drop batch files that no committed journal entry references.
    const referenced = new Set(ledger.batches.map((b) => `batch-${b.n}.json`));
    for (const name of store.listBatches()) {
      if (!referenced.has(name)) store.removeBatch(name);
    }
  }

  const input = fs.readFileSync(0, 'utf8');
  let lineNo = 0;
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    lineNo += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail('BAD_JSON', `line ${lineNo}: invalid JSON`);
    }
    try {
      const result = ledger.applyEvent(event);
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (err) {
      if (err instanceof LedgerError) fail(err.code, `line ${lineNo}: ${err.message}`);
      throw err;
    }
  }
}

main();
