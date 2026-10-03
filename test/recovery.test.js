'use strict';

// Acceptance 3: crash after writing the index but before writing the log
// leaves a dangling index row; recovery must drop it (and never the log).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Ledger, verifyFile, indexPathFor } = require('../lib/ledger');
const { tmpdir } = require('./util');

const T0 = 1_700_000_000_000;

test('dangling index row (index written, log not) is discarded on recovery', () => {
  const dir = tmpdir('ledger-crash-');
  const logPath = path.join(dir, 'ledger.log');
  let ledger = Ledger.create(logPath);
  for (let i = 0; i < 5; i++) {
    ledger.append({ type: 'post', account: 'A', amount: i + 1, bizKey: `k${i}` }, { ts: T0 + i * 1000, bizTime: T0 + i * 1000 });
  }
  const logSizeBefore = fs.statSync(logPath).size;

  // Simulate crash: index row for seq 5 exists, but the log line was never written.
  const dangling = JSON.stringify({ seq: 5, offset: logSizeBefore, length: 137, hash: 'deadbeef'.repeat(8) });
  fs.appendFileSync(indexPathFor(logPath), dangling + '\n');

  // Reopen: recovery must drop the dangling row.
  ledger = Ledger.open(logPath);
  assert.equal(ledger.entries.length, 5);
  const indexRows = fs.readFileSync(indexPathFor(logPath), 'utf8').trim().split('\n');
  assert.equal(indexRows.length, 5);
  assert.ok(!indexRows.some((r) => r.includes('deadbeef')));
  assert.equal(fs.statSync(logPath).size, logSizeBefore); // log untouched

  // Log still verifies and can be appended to after recovery.
  assert.equal(verifyFile(logPath, { now: T0 + 9999 }).ok, true);
  const e = ledger.append({ type: 'post', account: 'A', amount: 99, bizKey: 'k5' }, { ts: T0 + 5000, bizTime: T0 + 5000 });
  assert.equal(e.seq, 5);
  assert.equal(verifyFile(logPath, { now: T0 + 9999 }).entries, 6);
});

test('missing index tail (log written, index not) is rebuilt on recovery', () => {
  const dir = tmpdir('ledger-crash2-');
  const logPath = path.join(dir, 'ledger.log');
  let ledger = Ledger.create(logPath);
  for (let i = 0; i < 4; i++) {
    ledger.append({ type: 'post', account: 'A', amount: i + 1, bizKey: `k${i}` }, { ts: T0 + i * 1000, bizTime: T0 + i * 1000 });
  }
  // Simulate crash: keep only the first 2 index rows.
  const rows = fs.readFileSync(indexPathFor(logPath), 'utf8').trim().split('\n').slice(0, 2);
  fs.writeFileSync(indexPathFor(logPath), rows.join('\n') + '\n');

  ledger = Ledger.open(logPath);
  assert.equal(ledger.entries.length, 4);
  const rebuilt = fs.readFileSync(indexPathFor(logPath), 'utf8').trim().split('\n');
  assert.equal(rebuilt.length, 4);
  const last = JSON.parse(rebuilt[3]);
  assert.equal(last.seq, 3);
  assert.equal(last.offset + last.length, fs.statSync(logPath).size);
  assert.equal(verifyFile(logPath, { now: T0 + 9999 }).ok, true);
});
