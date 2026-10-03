#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createStore, applyEvent, computeHash, BiobankError } = require('../src/biobank');
const journal = require('../src/journal');
const { canonical } = require('../src/util');

function fail(code, detail, line) {
  process.stderr.write(JSON.stringify({ error: code, detail, line }) + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { journal: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--journal') {
      args.journal = argv[++i] || null;
    } else if (args.input === null) {
      args.input = argv[i];
    } else {
      fail('illegal_event', 'unexpected argument ' + argv[i], 0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let store = null;
  let seq = 0;
  if (args.journal && fs.existsSync(args.journal)) {
    const loaded = journal.load(args.journal);
    if (loaded.torn) {
      process.stderr.write(JSON.stringify({ warning: 'torn_journal_record', line: loaded.tornLine }) + '\n');
    }
    for (const rec of loaded.records) {
      if (rec.event && rec.event.type === 'config') {
        store = createStore(rec.event);
      } else {
        applyEvent(store, rec.event);
      }
      seq = rec.seq + 1;
    }
  }
  const inputText = args.input ? fs.readFileSync(path.resolve(args.input), 'utf8') : fs.readFileSync(0, 'utf8');
  const lines = inputText.split('\n');
  let lineNo = 0;
  for (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      fail('illegal_event', 'invalid JSON on line ' + lineNo, lineNo);
    }
    if (ev && ev.type === 'config') {
      if (store) {
        if (canonical(ev) !== canonical(store.configEvent)) {
          fail('illegal_event', 'config conflicts with journaled config', lineNo);
        }
        continue; // identical config on restart: skip
      }
      try {
        store = createStore(ev);
      } catch (e) {
        if (e instanceof BiobankError) fail(e.code, e.detail, lineNo);
        throw e;
      }
      if (args.journal) journal.append(args.journal, { seq, event: ev, hash: computeHash(store) });
      seq++;
      continue;
    }
    if (!store) fail('illegal_event', 'first event must be config', lineNo);
    let result;
    try {
      result = applyEvent(store, ev);
    } catch (e) {
      if (e instanceof BiobankError) fail(e.code, e.detail, lineNo);
      throw e;
    }
    if (args.journal) journal.append(args.journal, { seq, event: ev, hash: result.hash });
    seq++;
    process.stdout.write(JSON.stringify({ step: seq - 1, event: ev, ...result }) + '\n');
  }
}

main();
