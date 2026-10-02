'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../src/ledger');
const { JournalWriter, CrashError, recover } = require('../src/journal');
const { ERR } = require('../src/core');

const EVENTS = [
  { id: 'e1', type: 'open', account: 'a', amount: 100 },
  { id: 'e2', type: 'debit', account: 'a', amount: 30 },
  { id: 'e3', type: 'hold', account: 'a', amount: 20 },
  { id: 'e4', type: 'credit', account: 'a', amount: 5 },
];
const E5 = { id: 'e5', type: 'debit', account: 'a', amount: 10 };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
}

// Writes e1..e4 fully, then attempts e5 crashing at the given fault point.
function buildCrashedJournal(crashAfter) {
  const file = path.join(tmpdir(), 'journal.jsonl');
  const ledger = new Ledger();
  const writer = new JournalWriter(file);
  for (const ev of EVENTS) {
    ledger.apply(ev);
    writer.append(ledger, ev);
  }
  ledger.apply(E5);
  assert.throws(() => writer.append(ledger, E5, { crashAfter }), CrashError);
  return { file, writer };
}

function expectedState() {
  const ledger = new Ledger();
  for (const ev of EVENTS) ledger.apply(ev);
  return ledger.summary();
}

test('E: crash before writing event recovers to previous head', () => {
  const { file } = buildCrashedJournal('none');
  const { ledger, seq } = recover(file);
  assert.equal(seq, 4);
  assert.deepEqual(ledger.summary(), expectedState());
});

test('E: crash after event, before snapshot discards in-flight event', () => {
  const { file } = buildCrashedJournal('event');
  const { ledger, seq } = recover(file);
  assert.equal(seq, 4);
  assert.deepEqual(ledger.summary(), expectedState());
});

test('E: crash after snapshot, before head update ignores unconfirmed snapshot', () => {
  const { file } = buildCrashedJournal('snapshot');
  const { ledger, seq } = recover(file);
  assert.equal(seq, 4);
  assert.deepEqual(ledger.summary(), expectedState());
});

test('E: clean append after crash reuses seq and recovers fully', () => {
  const { file, writer } = buildCrashedJournal('event');
  const ledger = new Ledger();
  for (const ev of EVENTS) ledger.apply(ev);
  ledger.apply(E5);
  writer.append(ledger, E5);
  const recovered = recover(file);
  assert.equal(recovered.seq, 5);
  assert.deepEqual(recovered.ledger.summary(), ledger.summary());
});

test('E: duplicate event ids are idempotent on replay', () => {
  const file = path.join(tmpdir(), 'journal.jsonl');
  const ledger = new Ledger();
  ledger.apply(EVENTS[0]);
  const lines = [
    JSON.stringify({ kind: 'event', seq: 1, event: EVENTS[0] }),
    JSON.stringify({ kind: 'event', seq: 2, event: EVENTS[0] }), // duplicate id
    JSON.stringify({ kind: 'snapshot', seq: 2, state: ledger.serialize() }),
    JSON.stringify({ kind: 'head', seq: 2, id: 'e1' }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const { ledger: recovered, seq } = recover(file);
  assert.equal(seq, 2);
  assert.equal(recovered.summary().a.balance, 100); // applied once
});

test('E: corrupt journal mid-file raises CORRUPT_JOURNAL, torn tail is truncated', () => {
  const good = path.join(tmpdir(), 'journal.jsonl');
  const ledger = new Ledger();
  const writer = new JournalWriter(good);
  ledger.apply(EVENTS[0]);
  writer.append(ledger, EVENTS[0]);

  const corruptFile = path.join(tmpdir(), 'journal.jsonl');
  const lines = fs.readFileSync(good, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 0, '{"kind":"event","seq":1,"event":BROKEN');
  fs.writeFileSync(corruptFile, lines.join('\n') + '\n');
  assert.throws(() => recover(corruptFile), (e) => e.code === ERR.CORRUPT_JOURNAL);

  const torn = path.join(tmpdir(), 'journal.jsonl');
  fs.writeFileSync(torn, fs.readFileSync(good, 'utf8') + '{"kind":"event","se');
  const { seq } = recover(torn);
  assert.equal(seq, 1);
});
